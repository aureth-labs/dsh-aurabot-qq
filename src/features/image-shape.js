// 不指定构图时保留原 size；只映射明确选择的构图，不替接口静默改尺寸。
export const SHAPE_SIZE = {
  square: '1024x1024',
  portrait: '1024x1536',
  landscape: '1536x1024',
  wide: '1536x864',
}

// 面板和工具都提供的常用尺寸；2K/4K 是本次需求新增档位。
// 自定义接口仍可使用任意 WxH 的 imageGen.size；这里只约束工具显式传参。
export const SIZE_OPTIONS = ['512x512', '768x1024', '1024x768', '1024x1024', '1024x1536', '1536x1024', '1536x864', '2048x2048', '4096x4096']

export function normalizeRequestedSize(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '')
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(s)
  return m ? `${m[1]}x${m[2]}` : ''
}

export function pickShape(shape, config) {
  if (Object.hasOwn(SHAPE_SIZE, shape)) return shape
  return Object.hasOwn(SHAPE_SIZE, config.shape) ? config.shape : 'her'
}

export function imageSizeFor(shape, config) {
  return SHAPE_SIZE[pickShape(shape, config)] || config.size
}
