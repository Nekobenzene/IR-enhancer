/* 预置色标「IR-OTT」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-OTT",
  "nodes": [
    { "temperature_k": 301.15, "color": "#000000", "pinned": true },
    { "temperature_k": 253.15, "color": "#C8C8C8" },
    { "temperature_k": 253.15, "color": "#00FFFF" },
    { "temperature_k": 243.15, "color": "#000475" },
    { "temperature_k": 233.15, "color": "#00F902" },
    { "temperature_k": 233.15, "color": "#00FF00" },
    { "temperature_k": 223.15, "color": "#F9FF00" },
    { "temperature_k": 223.15, "color": "#FFFF00" },
    { "temperature_k": 213.15, "color": "#FF0700" },
    { "temperature_k": 213.15, "color": "#FF0000" },
    { "temperature_k": 203.15, "color": "#070000" },
    { "temperature_k": 203.15, "color": "#000000" },
    { "temperature_k": 193.15, "color": "#DFDEDE" },
    { "temperature_k": 193.15, "color": "#E865BD" },
    { "temperature_k": 183.15, "color": "#820382" },
    { "temperature_k": 183.15, "color": "#FFFFFF" }
  ]
});
