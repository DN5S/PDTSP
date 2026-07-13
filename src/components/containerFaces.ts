// Canvas-baked container textures and material factory. Textures are shared and
// cache-owned; materials are per box because callers mutate focus/hover state.

import * as THREE from 'three'

export type ContainerStyle = 'cell' | 'lid' | 'ion'

export const CONTAINER_STYLE_OPTIONS: { id: ContainerStyle; label: string }[] = [
  { id: 'cell', label: 'Cell' },
  { id: 'lid', label: 'Two-Tone' },
  { id: 'ion', label: 'Ion' },
]

/** Box cell counts in geometry space: w along x, h up, d depth. */
export interface ContainerCells {
  w: number
  h: number
  d: number
}

export interface ContainerMaterialParams {
  style: ContainerStyle
  cells: ContainerCells
  scu: number
  color: string | number
  /** Renderer max anisotropy, clamped to 8. */
  anisotropy?: number
}

type FaceKind = 'top' | 'side' | 'end' | 'bottom'

/** Baked texture resolution per 1-SCU cell. */
const CELL_PX = 128
const FACE_LUMA: Record<FaceKind, number> = { top: 1, side: 0.94, end: 0.88, bottom: 0.6 }
const TINT_BASE = new THREE.Color(0xe3e8f0)
const GRAPHITE_BASE = new THREE.Color(0x3a4150)
const ION_BODY = new THREE.Color(0x242b3c)

/** Build the 6-slot material array for one cargo box. Paired faces share materials. */
export function createContainerMaterials(params: ContainerMaterialParams): THREE.MeshStandardMaterial[] {
  const { style, cells, scu } = params
  const accent = new THREE.Color(params.color)
  const anisotropy = Math.min(8, params.anisotropy ?? 8)
  const stencil = String(scu)

  if (style === 'ion') {
    const body = (kind: FaceKind, u: number, v: number) =>
      cachedTexture(`ion-body|${kind}|${u}x${v}`, anisotropy, () => bakeIonBody(u, v, kind))
    const glow = (kind: FaceKind, u: number, v: number, withStencil: boolean) =>
      cachedTexture(`ion-glow|${kind}|${u}x${v}|${withStencil ? stencil : ''}`, anisotropy, () =>
        bakeIonGlow(u, v, kind, withStencil ? stencil : undefined),
      )
    const material = (kind: FaceKind, u: number, v: number, withStencil: boolean) => {
      if (kind === 'bottom') {
        return new THREE.MeshStandardMaterial({ map: body(kind, u, v), roughness: 0.5, metalness: 0.2 })
      }
      return new THREE.MeshStandardMaterial({
        map: body(kind, u, v),
        emissive: accent.clone().multiplyScalar(1.1),
        emissiveMap: glow(kind, u, v, withStencil),
        roughness: 0.36,
        metalness: 0.3,
      })
    }
    const end = material('end', cells.d, cells.h, false)
    const side = material('side', cells.w, cells.h, true)
    return [end, end, material('top', cells.w, cells.d, true), material('bottom', cells.w, cells.d, false), side, side]
  }

  // 'cell' tints via material.color; 'lid' bakes accent color into the texture.
  const colorKey = style === 'lid' ? `|${accent.getHexString()}` : ''
  const face = (kind: FaceKind, u: number, v: number, withStencil: boolean) =>
    cachedTexture(`${style}|${kind}|${u}x${v}|${withStencil ? stencil : ''}${colorKey}`, anisotropy, () =>
      bakeShellFace(u, v, kind, style, accent, withStencil ? stencil : undefined),
    )
  const material = (kind: FaceKind, u: number, v: number, withStencil: boolean) => {
    const map = face(kind, u, v, withStencil)
    const tinted = style === 'cell'
    return new THREE.MeshStandardMaterial({
      color: tinted ? accent : 0xffffff,
      map,
      emissive: tinted ? accent.clone().multiplyScalar(0.045) : new THREE.Color(0x0a0c10),
      emissiveMap: map,
      roughness: 0.52,
      metalness: 0.1,
    })
  }
  const end = material('end', cells.d, cells.h, false)
  const side = material('side', cells.w, cells.h, true)
  return [end, end, material('top', cells.w, cells.d, true), material('bottom', cells.w, cells.d, false), side, side]
}

const textureCache = new Map<string, THREE.CanvasTexture>()

function cachedTexture(key: string, anisotropy: number, bake: () => HTMLCanvasElement): THREE.CanvasTexture {
  let texture = textureCache.get(key)
  if (!texture) {
    texture = new THREE.CanvasTexture(bake())
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = anisotropy
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    // Scene teardown skips shared textures; the module cache owns them.
    texture.userData.shared = true
    textureCache.set(key, texture)
  }
  return texture
}

function shade(base: THREE.Color, mult: number): string {
  const c = base.clone().multiplyScalar(mult)
  return `#${c.getHexString()}`
}

function stencilFont(px: number): string {
  return `700 ${Math.round(px)}px Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif`
}

/** SCU marking: big numeral centered on top faces, top-left corner on walls. */
function drawStencil(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  kind: FaceKind,
  text: string,
  ink: string,
  topPad = 13,
) {
  ctx.fillStyle = ink
  if (kind === 'top') {
    const big = Math.min(96, Math.min(w, h) * 0.5)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'alphabetic'
    ctx.font = stencilFont(big)
    ctx.fillText(text, w / 2, h / 2 + big * 0.36)
    ctx.font = stencilFont(big * 0.28)
    ctx.globalAlpha = 0.8
    ctx.fillText('SCU', w / 2, h / 2 + big * 0.36 + big * 0.34)
    ctx.globalAlpha = 1
  } else {
    const big = CELL_PX * 0.38
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = stencilFont(big)
    ctx.fillText(text, 14, topPad)
    const bigWidth = ctx.measureText(text).width
    ctx.font = stencilFont(CELL_PX * 0.13)
    ctx.globalAlpha = 0.75
    ctx.fillText('SCU', 14 + bigWidth + 7, topPad + big * 0.62)
    ctx.globalAlpha = 1
  }
}

function makeCanvas(u: number, v: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = u * CELL_PX
  canvas.height = v * CELL_PX
  return [canvas, canvas.getContext('2d')!]
}

/** Painted shell face shared by 'cell' and 'lid'. */
function bakeShellFace(
  u: number,
  v: number,
  kind: FaceKind,
  style: 'cell' | 'lid',
  accent: THREE.Color,
  stencil?: string,
): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(u, v)
  const w = canvas.width
  const h = canvas.height

  const lidTop = style === 'lid' && kind === 'top'
  const base = style === 'cell' ? TINT_BASE : lidTop ? accent : GRAPHITE_BASE
  ctx.fillStyle = shade(base, FACE_LUMA[kind])
  ctx.fillRect(0, 0, w, h)

  // Baked falloff gives box faces depth without extra geometry.
  const fall = ctx.createLinearGradient(0, 0, 0, h)
  if (kind === 'side' || kind === 'end') {
    fall.addColorStop(0, 'rgba(255,255,255,0.07)')
    fall.addColorStop(0.55, 'rgba(255,255,255,0)')
    fall.addColorStop(1, 'rgba(0,0,0,0.14)')
  } else {
    fall.addColorStop(0, 'rgba(255,255,255,0.05)')
    fall.addColorStop(1, 'rgba(0,0,0,0.07)')
  }
  ctx.fillStyle = fall
  ctx.fillRect(0, 0, w, h)

  // Lid style carries mission color in a wall-top band.
  const band = style === 'lid' && kind !== 'top' && kind !== 'bottom'
  if (band) {
    const bandH = Math.round(CELL_PX * 0.24)
    ctx.fillStyle = shade(accent, kind === 'end' ? 0.92 : 1)
    ctx.fillRect(0, 0, w, bandH)
    ctx.fillStyle = 'rgba(255,255,255,0.1)'
    ctx.fillRect(0, 0, w, 2)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(0, bandH - 2, w, 2)
  }

  if (kind === 'bottom') return canvas

  // One recessed panel per 1-SCU cell.
  const margin = 9
  for (let cy = 0; cy < v; cy++) {
    for (let cx = 0; cx < u; cx++) {
      const x = cx * CELL_PX + margin
      const y = cy * CELL_PX + margin
      const s = CELL_PX - margin * 2
      ctx.fillStyle = 'rgba(0,0,0,0.06)'
      ctx.fillRect(x, y, s, s)
      ctx.fillStyle = 'rgba(255,255,255,0.16)'
      ctx.fillRect(x, y, s, 2)
      ctx.fillRect(x, y, 2, s)
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.fillRect(x, y + s - 2, s, 2)
      ctx.fillRect(x + s - 2, y, 2, s)

      // Faint wall corrugation, below seam contrast.
      if (kind === 'side' || kind === 'end') {
        const ribTop = cy * CELL_PX + CELL_PX * 0.26
        const ribH = CELL_PX * 0.48
        for (let i = -1; i <= 1; i++) {
          const rx = cx * CELL_PX + CELL_PX / 2 + i * 17
          ctx.fillStyle = 'rgba(0,0,0,0.07)'
          ctx.fillRect(rx - 2, ribTop, 2, ribH)
          ctx.fillStyle = 'rgba(255,255,255,0.05)'
          ctx.fillRect(rx, ribTop, 2, ribH)
        }
      }
    }
  }

  // Interior seams make the SCU footprint readable.
  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  for (let i = 1; i < u; i++) ctx.fillRect(i * CELL_PX - 1, 0, 3, h)
  for (let j = 1; j < v; j++) ctx.fillRect(0, j * CELL_PX - 1, w, 3)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  for (let i = 1; i < u; i++) ctx.fillRect(i * CELL_PX + 2, 0, 1, h)
  for (let j = 1; j < v; j++) ctx.fillRect(0, j * CELL_PX + 2, w, 1)

  // Perimeter edge, chamfer, and baked AO.
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fillRect(0, 0, w, 3)
  ctx.fillRect(0, h - 3, w, 3)
  ctx.fillRect(0, 0, 3, h)
  ctx.fillRect(w - 3, 0, 3, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.24)'
  ctx.lineWidth = 2
  ctx.strokeRect(5, 5, w - 10, h - 10)
  const ao = 14
  for (const [gx, gy, gw, gh, dir] of [
    [0, 0, w, ao, 'down'],
    [0, h - ao, w, ao, 'up'],
    [0, 0, ao, h, 'right'],
    [w - ao, 0, ao, h, 'left'],
  ] as const) {
    const g =
      dir === 'down' ? ctx.createLinearGradient(0, gy, 0, gy + gh)
      : dir === 'up' ? ctx.createLinearGradient(0, gy + gh, 0, gy)
      : dir === 'right' ? ctx.createLinearGradient(gx, 0, gx + gw, 0)
      : ctx.createLinearGradient(gx + gw, 0, gx, 0)
    g.addColorStop(0, 'rgba(0,0,0,0.13)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(gx, gy, gw, gh)
  }

  // Printed marking avoids floating labels that collide with stacked cargo.
  if (stencil) {
    const ink = style === 'cell' || lidTop ? 'rgba(9,13,20,0.72)' : 'rgba(216,226,242,0.85)'
    drawStencil(ctx, w, h, kind, stencil, ink, band ? Math.round(CELL_PX * 0.24) + 10 : 13)
  }

  return canvas
}

/** Ion Trace albedo: dark body with enough structure to read when dimmed. */
function bakeIonBody(u: number, v: number, kind: FaceKind): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(u, v)
  const w = canvas.width
  const h = canvas.height

  ctx.fillStyle = shade(ION_BODY, FACE_LUMA[kind])
  ctx.fillRect(0, 0, w, h)
  if (kind === 'bottom') return canvas

  const fall = ctx.createLinearGradient(0, 0, 0, h)
  fall.addColorStop(0, 'rgba(255,255,255,0.05)')
  fall.addColorStop(1, 'rgba(0,0,0,0.16)')
  ctx.fillStyle = fall
  ctx.fillRect(0, 0, w, h)

  const margin = 9
  for (let cy = 0; cy < v; cy++) {
    for (let cx = 0; cx < u; cx++) {
      const x = cx * CELL_PX + margin
      const y = cy * CELL_PX + margin
      const s = CELL_PX - margin * 2
      ctx.fillStyle = 'rgba(0,0,0,0.16)'
      ctx.fillRect(x, y, s, s)
      ctx.fillStyle = 'rgba(255,255,255,0.045)'
      ctx.fillRect(x, y, s, 2)
      ctx.fillRect(x, y, 2, s)
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.05)'
  for (let i = 1; i < u; i++) ctx.fillRect(i * CELL_PX - 1, 0, 2, h)
  for (let j = 1; j < v; j++) ctx.fillRect(0, j * CELL_PX - 1, w, 2)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(0, 0, w, 3)
  ctx.fillRect(0, h - 3, w, 3)
  ctx.fillRect(0, 0, 3, h)
  ctx.fillRect(w - 3, 0, 3, h)

  return canvas
}

/** Ion Trace emissive layer: white linework the material.emissive colors. */
function bakeIonGlow(u: number, v: number, kind: FaceKind, stencil?: string): HTMLCanvasElement {
  const [canvas, ctx] = makeCanvas(u, v)
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)

  // Quiet seams plus node intersections read better on large faces.
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  for (let i = 1; i < u; i++) ctx.fillRect(i * CELL_PX - 1, 0, 2, h)
  for (let j = 1; j < v; j++) ctx.fillRect(0, j * CELL_PX - 1, w, 2)
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  for (let i = 1; i < u; i++)
    for (let j = 1; j < v; j++) ctx.fillRect(i * CELL_PX - 3, j * CELL_PX - 3, 6, 6)

  // Hot frame/brackets keep flush neighbors visually separated.
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.lineWidth = 2.5
  ctx.strokeRect(4.5, 4.5, w - 9, h - 9)
  const arm = Math.round(CELL_PX * 0.26)
  const thick = 5
  const inset = 7
  ctx.fillStyle = 'rgba(255,255,255,1)'
  ctx.fillRect(inset, inset, arm, thick)
  ctx.fillRect(inset, inset, thick, arm)
  ctx.fillRect(w - inset - arm, inset, arm, thick)
  ctx.fillRect(w - inset - thick, inset, thick, arm)
  ctx.fillRect(inset, h - inset - thick, arm, thick)
  ctx.fillRect(inset, h - inset - arm, thick, arm)
  ctx.fillRect(w - inset - arm, h - inset - thick, arm, thick)
  ctx.fillRect(w - inset - thick, h - inset - arm, thick, arm)

  if (stencil) drawStencil(ctx, w, h, kind, stencil, 'rgba(255,255,255,0.95)')

  return canvas
}
