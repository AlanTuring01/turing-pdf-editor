// Tiny i18n. English is the default; 中文 kicks in automatically for zh-* browsers.
const STRINGS = {
  en: {
    'drop.title': 'Drop a PDF here',
    'drop.or': 'or',
    'drop.browse': 'choose a file',
    'drop.sample': 'try the sample',
    'drop.privacy': '100% local — your file never leaves this device.',
    'tool.select': 'Select & move (V)',
    'tool.edit': 'Edit existing text (E)',
    'tool.text': 'Add text (T)',
    'tool.sign': 'Signature (S)',
    'tool.white': 'White-out (W)',
    'zoom.out': 'Zoom out (−)',
    'zoom.in': 'Zoom in (+)',
    'zoom.fit': 'Click to fit width',
    'undo': 'Undo (⌘Z)',
    'redo': 'Redo (⇧⌘Z)',
    'download': 'Download',
    'saving': 'Saving…',
    'open.title': 'Open a PDF (⌘O)',
    'toast.saved': 'Saved {name}',
    'toast.loadfail': 'Could not open this file — is it a valid PDF?',
    'toast.encrypted': 'This PDF is password-protected. Nib can’t edit it yet.',
    'toast.rotated': 'This text is rotated — Nib can’t edit it yet.',
    'toast.placeSign': 'Click on the page to place your signature.',
    'toast.fontEmbedded': 'Font embedded: {name}',
    'toast.exportCancel': 'Download cancelled — a Unicode font is required.',
    'toast.emptyRestored': 'Edit removed — original text restored.',
    'toast.nothingToSave': 'No changes yet — edit something first.',
    'confirm.discard': 'You have unsaved edits. Open a new file anyway?',
    'edit.hint': 'Enter to apply · Esc to cancel · empty text restores the original',
    'sig.title': 'Add your signature',
    'sig.draw': 'Draw',
    'sig.type': 'Type',
    'sig.upload': 'Upload',
    'sig.clear': 'Clear',
    'sig.use': 'Use signature',
    'sig.cancel': 'Cancel',
    'sig.typePlaceholder': 'Type your name',
    'sig.removeWhite': 'Remove white background',
    'sig.uploadHint': 'PNG or JPG — a photo of your paper signature works too.',
    'sig.empty': 'Draw, type or upload a signature first.',
    'font.title': 'A Unicode font is needed',
    'font.body': 'Some of your text (e.g. 中文) can’t be written with the 14 built-in PDF fonts. Pick a font once and Nib will embed a tiny subset of it — still 100% offline.',
    'font.local': 'Use a system font',
    'font.localHint': 'Chrome / Edge only',
    'font.pick': 'Choose a font file (.ttf / .otf)',
    'font.scanning': 'Scanning system fonts…',
    'font.fail': 'No usable font found — please pick a .ttf/.otf file.',
    'text.size': 'Size',
    'unload.warn': 'You have unsaved edits.',
  },
  zh: {
    'drop.title': '把 PDF 拖到这里',
    'drop.or': '或',
    'drop.browse': '选择文件',
    'drop.sample': '试试示例文件',
    'drop.privacy': '100% 本地运行 — 文件永远不会离开这台设备。',
    'tool.select': '选择 / 移动 (V)',
    'tool.edit': '编辑原有文字 (E)',
    'tool.text': '添加文字 (T)',
    'tool.sign': '签名 (S)',
    'tool.white': '涂白 (W)',
    'zoom.out': '缩小 (−)',
    'zoom.in': '放大 (+)',
    'zoom.fit': '点击适配宽度',
    'undo': '撤销 (⌘Z)',
    'redo': '重做 (⇧⌘Z)',
    'download': '下载',
    'saving': '保存中…',
    'open.title': '打开 PDF (⌘O)',
    'toast.saved': '已保存 {name}',
    'toast.loadfail': '无法打开这个文件 — 确定是有效的 PDF 吗？',
    'toast.encrypted': '这是加密 PDF，Nib 暂时无法编辑。',
    'toast.rotated': '这段文字是旋转的，暂时无法编辑。',
    'toast.placeSign': '点击页面放置签名。',
    'toast.fontEmbedded': '已嵌入字体：{name}',
    'toast.exportCancel': '已取消下载 — 需要一个 Unicode 字体。',
    'toast.emptyRestored': '已删除修改，恢复原文。',
    'toast.nothingToSave': '还没有任何修改。',
    'confirm.discard': '当前修改尚未保存，确定打开新文件？',
    'edit.hint': 'Enter 应用 · Esc 取消 · 清空则恢复原文',
    'sig.title': '添加签名',
    'sig.draw': '手写',
    'sig.type': '输入',
    'sig.upload': '上传',
    'sig.clear': '清除',
    'sig.use': '使用签名',
    'sig.cancel': '取消',
    'sig.typePlaceholder': '输入你的名字',
    'sig.removeWhite': '去除白色背景',
    'sig.uploadHint': 'PNG 或 JPG — 纸上签名的照片也可以。',
    'sig.empty': '请先手写、输入或上传一个签名。',
    'font.title': '需要一个 Unicode 字体',
    'font.body': '你的部分文字（如中文）无法用 PDF 内置的 14 种西文字体写入。选择一次字体，Nib 会只嵌入用到的字形子集 — 依然完全离线。',
    'font.local': '使用系统字体',
    'font.localHint': '仅 Chrome / Edge',
    'font.pick': '选择字体文件 (.ttf / .otf)',
    'font.scanning': '正在扫描系统字体…',
    'font.fail': '没有找到可用字体 — 请手动选择 .ttf/.otf 文件。',
    'text.size': '字号',
    'unload.warn': '当前修改尚未保存。',
  },
};

// localStorage throws when site data is blocked — never let that kill the app
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};

let lang = store.get('nib.lang')
  || (navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en');

export function t(key, params) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
  // function replacement so "$&"-style patterns in file names stay literal
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, () => v);
  return s;
}

export function getLang() { return lang; }

export function setLang(l) {
  lang = l;
  store.set('nib.lang', l);
  applyLang();
}

export function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  const toggle = document.getElementById('langToggle');
  if (toggle) toggle.textContent = lang === 'zh' ? 'EN' : '中';
}
