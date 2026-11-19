/**
 * 原生「选择文件夹」对话框自检：只编译 C# 类型 + 创建 COM 对象 + SetFolder，不 Show（不会弹窗）。
 * 校验点：Add-Type 能编译、IFileOpenDialog 能创建、Per-Monitor V2 DPI 生效、中文经 Base64 通道往返不乱码。
 */
import { selftestNativePicker } from '../lib/native-picker.js'

const text = await selftestNativePicker(process.cwd())
console.log(text)
if (!text.includes('cn=OK') || text.startsWith('ERR:')) {
  process.exit(1)
}
