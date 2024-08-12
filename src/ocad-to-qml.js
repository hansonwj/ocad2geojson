const { LineSymbolType, AreaSymbolType } = require('./ocad-reader/symbol-types')
const { patternToSvg, createSvgNode } = require('./ocad-to-svg')
const uuidv4 = require('uuid/v4')
const _global = getGlobal()
const DOMImplementation = _global.DOMImplementation
  ? _global.DOMImplementation
  : new (require('xmldom').DOMImplementation)()
const XMLSerializer = _global.XMLSerializer
  ? _global.XMLSerializer
  : require('xmldom').XMLSerializer

const defaultOptions = {
  generateSymbolElements: true,
  exportHidden: false,
}

/**
 * @typedef {object} NodeDef
//  * @property {string=} id
//  * @property {string} type
//  * @property {Record<string, string|number>=} attrs
//  * @property {NodeDef[]=} children
 */

module.exports = function ocadToQml(ocadFile, options) {
  options = { ...defaultOptions, ...options }

  const usedSymbols = usedSymbolNumbers(ocadFile)
    .map(symNum => ocadFile.symbols.find(s => symNum === s.symNum))
    .filter(s => s)

  const root = {
    type: 'qgis',
    attrs: {
      simplifyMaxScale: 1,
      minScale: 1e8,
      readOnly: 0,
      simplifyDrawingTol: 1,
      hasScaleBasedVisibilityFlag: 0,
      simplifyAlgorithm: 0,
      maxScale: 0,
      labelsEnabled: 0,
      styleCategories: 'AllStyleCategories',
      simplifyDrawingHints: 1,
      simplifyLocal: 1,
    },
    children: [
      {
        type: 'renderer-v2',
        attrs: {
          forceraster: 0,
          symbollevels: 0,
          type: 'RuleRenderer',
          enableorderby: 0,
        },
        children: [
          {
            type: 'rules',
            attrs: {
              key: `{${uuidv4()}}`,
            },
            children: usedSymbols.map((sym, i) => ({
              type: 'rule',
              attrs: {
                key: `{${uuidv4()}}`,
                symbol: i,
                label: `${Math.floor(sym.symNum / 1000)}.${sym.symNum % 1000} ${
                  sym.description
                }`,
                filter: `sym=${sym.symNum}`,
              },
            })),
          },
          {
            type: 'symbols',
            children: usedSymbols
              .map((sym, i) => ({
                ...symbolToQml(ocadFile.getCrs().scale, ocadFile.colors, sym),
                type: 'symbol',
                attrs: {
                  name: i,
                  clip_to_extent: 1,
                  alpha: 1,
                  type:
                    sym.type === LineSymbolType
                      ? 'line'
                      : sym.type === AreaSymbolType
                      ? 'fill'
                      : '',
                  force_rhr: 0,
                },
              }))
              .sort((a, b) => a.order - b.order),
          },
        ],
      },
    ],
  }

  const doc = DOMImplementation.createDocument(null, 'xml', null)
  return createXmlNode(doc, root)
}

/**
 *
 * @param {Document} document
 * @param {NodeDef} n
 * @returns {HTMLElement}
 */
const createXmlNode = (document, n) => {
  const node = document.createElement(n.type)
  if (n.id) {
    node.id = n.id
  }
  if (n.attrs) {
    for (const attrName in n.attrs) {
      node.setAttribute(attrName, n.attrs[attrName].toString())
    }
  }
  if (n.children) {
    for (const child of n.children) {
      node.appendChild(createXmlNode(document, child))
    }
  }

  return node
}

const usedSymbolNumbers = ocadFile =>
  ocadFile.objects.reduce(
    (a, f) => {
      const symbolNum = f.sym
      if (!a.idSet.has(symbolNum)) {
        a.symbolNums.push(symbolNum)
        a.idSet.add(symbolNum)
      }

      return a
    },
    { symbolNums: [], idSet: new Set() }
  ).symbolNums

/**
 * Transform a symbol to QML
 * @param {number} scale
 * @param {*} colors
 * @param {import("./ocad-reader/symbol").BaseSymbolDef} sym
 * @returns {{children: NodeDef[]}}
 */
const symbolToQml = (scale, colors, sym) => {
  /** @type {NodeDef[]} */
  let children

  switch (sym.type) {
    case LineSymbolType: {
      if (sym.type !== 2)
        throw new Error('Symbol mismatch: area object with non-area symbol')
      const lineColor = colors[sym.lineColor]
      if (lineColor) {
        const baseMainGap = sym.mainGap
        const baseMainLength = sym.mainLength
        children = [
          {
            type: 'layer',
            attrs: {
              class: 'SimpleLine',
              pass: 1000 - lineColor.renderOrder,
              enabled: 1,
              locked: 0,
            },
            children: [
              prop(
                'line_color',
                Array.from(lineColor.rgbArray).concat([255]).join(',')
              ),
              prop('line_style', 'solid'),
              prop('line_width', toMapUnit(scale, sym.lineWidth)),
              prop('line_width_unit', 'MapUnit'),
              prop('joinstyle', 'bevel'),
              prop('capstyle', 'flat'),
            ].concat(
              baseMainGap && baseMainLength
                ? [
                    prop(
                      'customdash',
                      [baseMainLength, baseMainGap]
                        .map(x => toMapUnit(scale, x))
                        .join(';')
                    ),
                    prop('customdash_unit', 'MapUnit'),
                    prop('use_custom_dash', 1),
                  ]
                : []
            ),
          },
        ]
      }
      break
    }
    case AreaSymbolType: {
      if (sym.type !== 3)
        throw new Error('Symbol mismatch: area object with non-area symbol')
      const fillColor = colors[sym.fillColor]
      const hasPatternFill = sym.hatchMode || sym.structMode
      children = []
      if (fillColor && (!hasPatternFill || sym.fillOn)) {
        children.push({
          type: 'layer',
          attrs: {
            class: 'SimpleFill',
            pass: 1000 - fillColor.renderOrder,
            enabled: 1,
            locked: 0,
          },
          children: [
            prop(
              'color',
              Array.from(fillColor.rgbArray).concat([255]).join(',')
            ),
            prop('outline_style', 'no'),
            prop('style', 'solid'),
          ],
        })
      }
      if (fillColor && hasPatternFill) {
        const patterns = patternToSvg(colors, sym)
        children = children.concat(
          patterns.map(p => svgPatternToFill(scale, fillColor, p))
        )
      }
      break
    }
  }

  return {
    children,
  }
}

/**
 *
 * @param {number} scale
 * @param {import('./ocad-reader/ocad-file').Color} fillColor
 * @param {NodeDef} pattern
 * @returns {NodeDef}
 */
const svgPatternToFill = (scale, fillColor, pattern) => {
  const { width, height, patternTransform } = pattern.attrs
  const angle = getPatternRotation(patternTransform)
  const svgDoc = DOMImplementation.createDocument(
    'http://www.w3.org/2000/svg',
    'svg',
    null
  )
  svgDoc.firstChild.setAttribute('width', width)
  svgDoc.firstChild.setAttribute('height', height)
  pattern.children.forEach(c =>
    svgDoc.firstChild.appendChild(
      createSvgNode(
        svgDoc,
        /** @type {import('./ocad-to-svg').SvgNodeDef} */ (c)
      )
    )
  )
  const serializedSvg = new XMLSerializer().serializeToString(svgDoc)
  const patternBase64 =
    'base64:' + Buffer.from(serializedSvg).toString('base64')

  return {
    type: 'layer',
    attrs: {
      class: 'SVGFill',
      pass: 1000 - fillColor.renderOrder,
      enabled: 1,
      locked: 0,
    },
    children: [
      prop('pattern_width_unit', 'MapUnit'),
      prop('outline_style', 'no'),
      prop('svgFile', patternBase64),
      prop('width', toMapUnit(scale, width)),
      prop('height', toMapUnit(scale, height)),
      prop('angle', angle),
      {
        type: 'symbol',
        attrs: {
          clip_to_extent: 1,
          alpha: 1,
          type: 'line',
          force_rhr: 0,
        },
        children: [
          {
            type: 'layer',
            attrs: {
              class: 'SimpleLine',
              locked: 0,
              enabled: 1,
              pass: 0,
            },
            children: [
              prop('line_color', '0,0,0,0'),
              prop('line_style', 'solid'),
              prop('line_width', 0),
              prop('line_width_unit', 'MapUnit'),
              prop('joinstyle', 'bevel'),
              prop('capstyle', 'flat'),
            ],
          },
        ],
      },
    ],
  }
}

const prop = (k, v) => ({
  type: 'prop',
  attrs: { k, v },
})

const toMapUnit = (scale, x) => (x / (100 * 1000)) * scale

function getGlobal() {
  if (typeof global !== 'undefined') {
    return global
  } else if (typeof window !== 'undefined') {
    return window
  } else {
    return {}
  }
}

function getPatternRotation(patternTransform) {
  if (patternTransform) {
    const rotationMatch = /rotate\((.*)\)/.exec(patternTransform)
    if (rotationMatch) {
      return Number(rotationMatch[1])
    }
  }
  return 0
}
