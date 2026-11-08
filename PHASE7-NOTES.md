# PHASE7 补充需求备忘（用户原话，写进第二波任务 brief 用）

## 开场动画（不是广告）
- 开场动画是产品自己的开场动画，绝不是广告位，不要做成广告位。
- 内容：斯诺登主题远景（默认壁纸 snowden-vista.jpg）+ 品牌字标呈现 + 光效，轻量（纯 CSS 动效，不拖首屏），可跳过（跳过按钮 + “不再显示”选项，存 localStorage）。
- 顺序：先远景、再品牌字标呈现，与默认壁纸呼应。

## 开场动画里的斯诺登名言（轮换显示，只用以下三句核实过的，不要自己编新的）
- 英文原文显示，可配中文小字翻译。
- 主推（第 1 句）：
  > "Arguing that you don't care about the right to privacy because you have nothing to hide is no different than saying you don't care about free speech because you have nothing to say."
  > — Edward Snowden
  > 中文小字：说你不在乎隐私权，因为你没什么可隐瞒的，就像说你不在乎言论自由，因为你没什么可说的。
- 备用（第 2 句）：
  > "Privacy isn't about something to hide. Privacy is about something to protect."
  > 中文小字：隐私不是关于有什么可隐瞒的，而是关于有什么要保护的。
- 备用（第 3 句）：
  > "Under observation, we act less free, which means we effectively are less free."
  > 中文小字：在被监视之下，我们行动得更不自由，这意味着我们实际上也就不自由了。

## 其他已定事项（备忘）
- 默认主屏背景：snowden-vista.jpg（wallpapers.json 里 isDefault: true），用户可在壁纸选择器里换别的。
- 壁纸共 15 张（写真 5 张 + 其他 9 类 + 斯诺登远景 1 张），清单在 mail-vue/public/wallpapers/wallpapers.json，含 tags/mood 字段供按喜好推荐。
- AI 模型：Workers AI 开源权重，主用 @cf/meta/llama-3.1-8b-instruct，备用 @cf/meta/llama-3-8b-instruct；不接闭源商业 API。
- 隐私审计发现写 PHASE7-PRIVACY-AUDIT.md，最后合并进 PHASE7.md。
