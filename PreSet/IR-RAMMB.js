/* 预置色标「IR-RAMMB」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-RAMMB",
  "nodes": [
    { "temperature_k": 308.15, "color": "#000000", "pinned": true },
    { "temperature_k": 243.15, "color": "#FFFFFF" },
    { "temperature_k": 243.15, "color": "#B5FFFF" },
    { "temperature_k": 223.15, "color": "#565757" },
    { "temperature_k": 223.15, "color": "#000062" },
    { "temperature_k": 213.15, "color": "#0000FB" },
    { "temperature_k": 213.15, "color": "#006100" },
    { "temperature_k": 203.15, "color": "#00FC00" },
    { "temperature_k": 203.15, "color": "#610000" },
    { "temperature_k": 193.15, "color": "#FB0000" },
    { "temperature_k": 193.15, "color": "#FFFF00" },
    { "temperature_k": 183.15, "color": "#56564D" },
    { "temperature_k": 183.15, "color": "#FFFFFF" },
    { "temperature_k": 173.15, "color": "#565656" }
  ]
});
