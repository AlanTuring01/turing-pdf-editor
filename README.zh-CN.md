<div align="center">

<img src="assets/logo.svg" width="72" alt="Turing PDF Editor logo">

# Turing PDF Editor

**一个住在浏览器里的迷你 PDF 编辑器。**
点一行字，改掉，下载。文件从头到尾不离开你的设备。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build step: none](https://img.shields.io/badge/build_step-none-success.svg)](#how-it-works)
[![100% client-side](https://img.shields.io/badge/100%25-client--side-6366f1.svg)](#privacy-the-actual-feature)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**[▶ 在线试用](https://alanturing01.github.io/turing-pdf-editor/)** —— 不注册、不上传、无水印。

[English](README.md) | **简体中文**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="docs/hero-light.png">
  <img src="docs/hero-light.png" alt="Turing editing a proposal PDF in the browser" width="880">
</picture>

</div>

晚上 6:58，合同 7 点整要发出去，第 3 页的日期写着 **3 月 12 日**，而正确的是 **3 月 21 日**。以前你只有三条路：把私密合同上传到陌生人的服务器，换回一份带水印的文件；装一个几百 MB 的桌面套件；或者打印出来、用笔改、再扫描回去。

Turing 是缺失的第四个选项：开个标签页，点一下日期，改掉，下载。

## 为什么你会喜欢它

- **零构建。** 没有打包器，没有转译器，没有 `node_modules`。克隆仓库，随便找个静态服务器一跑就行。
- **约 2,000 行原生 JS**，一个下午就能通读。没有框架，整个应用摊在你眼前。
- **依赖全部随仓库内置。** [pdf.js](https://mozilla.github.io/pdf.js/) v6（渲染）、[pdf-lib](https://pdf-lib.js.org/)（写入）、[fontkit](https://github.com/foliojs/fontkit)（字体子集化）、[tesseract.js](https://tesseract.projectnaptha.com/)（OCR），都直接放在仓库里。
- **一个漂亮的字体子集化技巧。** 非拉丁文字需要内嵌字体，Turing 只嵌你实际用到的字形——22 MB 的字体，进了 PDF 只剩约 16 KB。

## 快速开始

```bash
git clone https://github.com/AlanTuring01/turing-pdf-editor
cd turing-pdf-editor
python3 -m http.server 8080    # or: npx serve
```

打开 <http://localhost:8080>。（ES modules + worker 需要 HTTP，`file://` 跑不起来。）

或者干脆用 **[在线版](https://alanturing01.github.io/turing-pdf-editor/)**——同一套静态文件，托管在 GitHub Pages 上。

## 功能

**✏️ 编辑 PDF 里已有的文字。** 点一行，重新输入，完事。Turing 会把 PDF 里碎片化的文本片段合并成可编辑的整行，从渲染后的页面上采样原始文字色和背景色，并匹配字号与字族（衬线 / 无衬线 / 等宽，粗体 / 斜体）——改完就像原来就是这样。

**🖋 签名。** 用鼠标或手指手写（笔画平滑，黑或蓝墨水），输入姓名生成手写体或衬线体，或者上传一张纸质签名的照片——Turing 自动抠掉白底。随意拖动、缩放。

<div align="center">
  <img src="docs/signature.png" alt="Signature modal with a drawn stroke" width="480">
</div>

**🖼 插入图片。** Logo、印章、图表、照片——选文件、把图拖到页面上，或者直接 <kbd>Cmd/Ctrl</kbd>+<kbd>V</kbd> 粘贴一张截图。拖动移动、拖角缩放（锁定比例）。JPEG 按 JPEG 嵌入，照片不会把文件撑大。

**➕ 加文字和涂白。** 新文字可调字号、三种颜色、支持多行。涂白会自动采样页面背景色，非白底页面照样能用。

**🔍 扫描件？OCR 它。** 扫描页只是一堆像素——点一下**识别文字 (OCR)**，本机识别引擎（tesseract.js，内置英文和简体中文）就把它变成一行行可点击、可编辑的文字。你改的内容会以*真正的文本*写进 PDF——导出后那一行可以被选中复制，比原始扫描件还强。全程零上传。

**🌏 中文、日本語，任何 Unicode。** PDF 的 14 个内置字体只认拉丁字母——这就是大多数工具碰上中文日文会悄悄坏掉的原因。Turing 只问你要一次字体：通过 Local Font Access API 从系统里挑（Chrome/Edge），或拖进任意 `.ttf`/`.otf`——然后只内嵌你用到的字形。

**⌨️ 手感像个真编辑器。** 全程可撤销/重做（<kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>），缩放，单键切换工具：<kbd>V</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>S</kbd> <kbd>I</kbd> <kbd>W</kbd>。

**🌐 中文/English 界面**，自动识别，一键切换。浅色深色主题，跟随系统。

**📄 应付真实世界的 PDF。** 正确处理旋转页面（`/Rotate` 90/180/270），支持多页文档，页面按需懒渲染。

## 隐私（这才是核心功能）

Turing **100% 在客户端运行**。你的文件**永远**不会离开你的设备。

- 不上传。没有服务器。不用注册。没有跟踪。没有水印。没有文件大小限制。
- 首次加载后可离线使用。
- 所有依赖库都在本地。

别光听我们说——打开 DevTools 看网络面板：你能看到的唯一流量，是应用从自己的域名懒加载自带文件（比如首次使用时约 10 MB 的 OCR 引擎）。**你的 PDF 永远不会出现在任何请求里。**

## 工作原理

```
your.pdf
   │
   ▼
┌────────────────────────────────────────────┐
│ pdf.js v6 · renders each page to canvas    │
└──────────────────────┬─────────────────────┘
                       │  text runs + pixels
┌──────────────────────▼─────────────────────┐
│ app · ~2,000 lines of vanilla JS           │
│ merge runs · sample colors · match fonts   │
└──────────────────────┬─────────────────────┘
                       │  edit ops
┌──────────────────────▼─────────────────────┐
│ pdf-lib + fontkit · cover-and-replace      │
│ edits, fonts subset to the glyphs used     │
└──────────────────────┬─────────────────────┘
                       ▼
            edited.pdf · never left your device
```

三件事承担了重活：

1. **文本片段合并。** PDF 把文字存成任意碎片——一句话可能是十几个各自定位的片段。Turing 把同一基线上的片段缝成一条可编辑的行，"点一下就能改"就是这么来的。
2. **像素采样。** 编辑某行时，Turing 会读取渲染后的 canvas，采样原始文字颜色*和*它背后的背景色，用页面自己的颜色打补丁，而不是想当然地黑字白底。
3. **字形级字体子集化。** 输入非拉丁文字时，fontkit 只从你选的字体里切出用到的字形，pdf-lib 把这一小片嵌进去——按 KB 算，不是 MB。

没有框架，没有状态库，没有构建流水线。直接 view-source 就能看——对一个你要喂合同进去的工具来说，这一点恰恰是重点。

## Turing vs. 其他方案

| | 在线 PDF 编辑器 | 桌面套件 | **Turing** |
|---|---|---|---|
| 你的文件 | 上传到对方服务器 | 留在本地 | **留在本地** |
| 价格 | 付费墙 + 水印 | 订阅制 | **免费（MIT）** |
| 安装 | — | 几百 MB | **不用装——它就是个网页** |
| 文件大小限制 | 通常有 | 无 | **无** |
| 源代码 | 闭源 | 大多闭源 | **开源** |

## FAQ 与诚实的局限

**这是脱敏（redaction）工具吗？**
**不是。** 文字编辑用的是经典的"覆盖重写"手法：原始字符仍留在文件的内容流里，复制粘贴或文本提取依然能找到它们。改个错别字没问题；**藏机密不行**。真正的字形级删除在路线图上。

**涂白能彻底抹掉内容吗？**
同样的答案——只是视觉遮盖，不是安全脱敏。

**能编辑旋转或竖排的文字吗？**
旋转的*页面*没问题。页面*内*旋转或竖排的文字暂时不能编辑——你会收到一条友好的提示，而不是一次坏掉的编辑。

**带密码的 PDF？**
不支持。

**改出来的文字用的是文档原字体吗？**
替换文字用的是匹配的标准字体（或你选的 Unicode 字体），不是文档内嵌的原字体。对无衬线/衬线正文来说，通常肉眼分不出来。

**扫描版 PDF？**
扫描件是图片，没有文本层——点页面上的**识别文字 (OCR)**。识别完全在本机运行（tesseract.js，内置英文和简体中文），识别出的每一行都和普通文字一样点击即改。涂白和加文字不需要 OCR 也照常可用。

## 路线图

- [ ] 真正从内容流中删除文字（真·脱敏）
- [ ] 页面管理：排序 / 删除 / 旋转
- [ ] 表单填写
- [ ] 手绘批注
- [ ] PWA 离线安装
- [ ] 更多 OCR 语言（放入 traineddata 即可）

## 参与贡献

Turing 的意义就在于它好改：

1. 克隆，起个静态服务器，打开应用。
2. 改 JS，刷新。整个工作流就这么多——不用构建，不用 watch，不用装依赖。

附带示例 PDF 的 bug 报告（别放敏感文件！）价值千金。欢迎 PR——代码量小到可以整个装进脑子里。

## 许可证

[MIT](LICENSE)——想怎么用就怎么用，只是别把合同传给陌生人。
