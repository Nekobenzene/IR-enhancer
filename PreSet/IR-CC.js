/* 预置色标「IR-CC」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-CC",
  "nodes": [
    { "temperature_k": 301.15, "color": "#000000", "pinned": true },
    { "temperature_k": 282.15, "color": "#FFFFFF" },
    { "temperature_k": 282.15, "color": "#674949" },
    { "temperature_k": 242.15, "color": "#FFE1E1" },
    { "temperature_k": 242.15, "color": "#A02323" },
    { "temperature_k": 231.15, "color": "#A02323" },
    { "temperature_k": 231.15, "color": "#FF6E00" },
    { "temperature_k": 219.15, "color": "#FF6E00" },
    { "temperature_k": 219.15, "color": "#FFE132" },
    { "temperature_k": 209.15, "color": "#FFE132" },
    { "temperature_k": 209.15, "color": "#A0D2FF" },
    { "temperature_k": 203.15, "color": "#A0D2FF" },
    { "temperature_k": 203.15, "color": "#00BFFF" },
    { "temperature_k": 197.15, "color": "#00BFFF" },
    { "temperature_k": 197.15, "color": "#4169E1" },
    { "temperature_k": 192.15, "color": "#4169E1" },
    { "temperature_k": 192.15, "color": "#000096" },
    { "temperature_k": 188.15, "color": "#000096" },
    { "temperature_k": 188.15, "color": "#FFFFFF" }
  ]
});
