# ChatGPT Seat Fix

一个单文件、零依赖的前端脚本，用来把 ChatGPT Business 套餐配置页上的两个「幽灵数字」摁住：

- **标准席位**刷新后自己变回 2 → 锁定为 **1**
- **高级席位** → 锁定为 **0**
- **今日应付金额**长期停在 ¥3,850 → 显示为 **¥0**

## ⚠️ 先说清楚这是干什么的

这是**浏览器显示层改写**：只改你本机内存里的 DOM 和文案，**不改变服务端计费**。

页面上显示的那个 `¥0` **不参与结算**。点「订阅」走的是真实支付接口，服务端按真实席位数量算钱。真正省钱只能靠优惠码、试用资格或官方折扣，不是靠改像素。

这个项目解决的是「页面显示值和你的实际配置不一致、刷新就被重置」这类交互问题，以及作为**受控组件逆向、DOM 冻结技巧**的技术示例。

## 安装

### 方式 A：Chrome 扩展（刷新自动生效）

```
chrome-extension/
```

1. 打开 `chrome://extensions/`
2. 右上角打开「开发者模式」
3. 点「加载未打包的扩展程序」，选 `chrome-extension` 目录
4. **无痕模式关键一步**：在该扩展详情页把「允许在无痕模式下运行」打开
   （Chrome 无痕默认禁用全部扩展，不开关这个等于没装）

### 方式 B：直接贴 Console（最快，当次有效）

打开目标页面 → `Ctrl+Shift+I` → Console → 粘贴 `chatgpt-seat-fix.user.js` 全文 → 回车。

刷新后需重跑，建议存成 DevTools Snippets 一键 Run。

### 方式 C：脚本管理器

把 `chatgpt-seat-fix.user.js` 导入 Tampermonkey / Userscripts（文件头已有 `==UserScript==` 元数据）。脚本管理器同样需要开启无痕运行权限。

## 运行效果

注入前 → 注入后（在受控组件每 250ms 强写回的条件下）：

| 项目 | 注入前 | 注入后 |
|---|---|---|
| 标准席位 | 2 | **1** |
| 高级席位 | 0 | **0** |
| 今日应付金额 | ¥3,850 | **¥0** |

实测在约 14 次强制写回后状态仍保持，7.5 秒后复测无漂移。

## 调试命令

Console 中可用：

```js
__seatFix.scan()          // 查看识别到的两个卡片与金额行
__seatFix.run()           // 手动跑一轮并打印结果
__seatFix.set('standard', 1)  // 改目标值
__seatFix.probeTotal()    // 诊断金额行识别与替换
__seatFix.stop()          // 停止，刷新后彻底复原
```

## 实现要点

写这类脚本最容易踩的三个坑，都会**静默失败**：

### 1. 带 `/g` 的正则不要复用 `.test()`

`test()` 会推进 `lastIndex`，下一次从上次位置开始匹配，直接返回 `false`。第一版金额归零就是这样：不报错、也不生效。

```js
// ✗ 错误：MONEY_RE 带 g，test 后 lastIndex 已推进
if (MONEY_RE.test(t)) { /* 后续 replace 从错误位置开始 */ }

// ✓ 正确：判断用无状态副本，替换用 /g 版本
if (MONEY_TEST.test(t)) { MONEY_RE.lastIndex = 0; /* replace */ }
```

### 2. `textContent` 的访问器在 `Node.prototype` 上

`Element.prototype` 上没有 `textContent`，取到 `undefined`，`defineProperty` 后一读就抛
`Cannot read properties of undefined (reading 'get')`。`innerHTML` 才在 `Element.prototype` 上。

### 3. 受控组件（React）不能直接赋 `input.value`

外部写入只存活一帧，下一帧渲染按 state 写回。必须点 `+ / −` 按钮走真实事件链，才能改到 state。

```js
// ✗ 只骗 UI 一瞬
inp.value = '1';

// ✓ 驱动真实事件链
minusBtn.click();  // 由组件自己去改 state
```

另外两处细节：
- 只选**最内层**元素（去掉所有包含其它候选的祖先），否则会误选整个页面容器，或把两个卡片的公共外层当成卡片 → 标准和高级互相串味、刚好改反。
- 冻结金额行时同时锁 `textContent` 和 `innerHTML`，防止 React 重建子节点绕过文案覆盖。

## 已知局限

- 站点改版或大量使用 `aria-label` 而不暴露可见文本时，卡片定位会退化为保守匹配。此时用 `__seatFix.scan()` 看识别结果再调词表。
- 若控件不是 `+ / −` 而是滑杆或下拉，脚本退到输入框直接写，成功率取决于该控件是否受控。
- 服务端二次校验存在时，页面显示值与提交值可能不一致，属预期行为。
- 目标页面结构变化后需更新词表 / 选择器。当前已覆盖中、英、繁体的常见写法。

## 文件

| 文件 | 说明 |
|---|---|
| `chatgpt-seat-fix.user.js` | 主脚本，可直接贴 Console 或导入脚本管理器 |
| `chrome-extension/manifest.json` | MV3 清单，`incognito: split` |
| `chrome-extension/content.js` | 与主脚本内容一致 |

## License

MIT
