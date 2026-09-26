/* 预置色标「IR-BW」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-BW",
  "nodes": [
    { "temperature_k": 323.15, "color": "#000000", "pinned": true },
    { "temperature_k": 188.15, "color": "#FFFFFF" }
  ]
});
