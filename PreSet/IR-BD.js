/* 预置色标「IR-BD」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-BD",
  "nodes": [
    { "temperature_k": 301.15, "color": "#000000", "pinned": true },
    { "temperature_k": 301.15, "color": "#030303" },
    { "temperature_k": 282.15, "color": "#F7F7F7" },
    { "temperature_k": 282.15, "color": "#6D6D6D" },
    { "temperature_k": 242.15, "color": "#CACACA" },
    { "temperature_k": 242.15, "color": "#3C3C3C" },
    { "temperature_k": 231.15, "color": "#3C3C3C" },
    { "temperature_k": 231.15, "color": "#6E6E6E" },
    { "temperature_k": 219.15, "color": "#6E6E6E" },
    { "temperature_k": 219.15, "color": "#A0A0A0" },
    { "temperature_k": 209.15, "color": "#A0A0A0" },
    { "temperature_k": 209.15, "color": "#000000" },
    { "temperature_k": 203.15, "color": "#000000" },
    { "temperature_k": 203.15, "color": "#FFFFFF" },
    { "temperature_k": 197.15, "color": "#FFFFFF" },
    { "temperature_k": 197.15, "color": "#878787" },
    { "temperature_k": 192.15, "color": "#878787" },
    { "temperature_k": 192.15, "color": "#555555" }
  ]
});
