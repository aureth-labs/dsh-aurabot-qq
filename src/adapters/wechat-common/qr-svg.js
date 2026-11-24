// 薄包装 re-export：通用零依赖 QR 编码与 SVG 渲染已抽离至 src/core/qr.js，保留旧导入路径向后兼容。
export {
  MAX_QR_UTF8_BYTES,
  encodeQrMatrix,
  encodeQrSvg,
  encodeQrSvgDataUri,
  isSafeQrImageDataUri,
  renderQrDataUri,
} from '../../core/qr.js'
