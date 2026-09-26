/* 预置色标「IR-RBTOP」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-RBTOP",
  "nodes": [
    { "temperature_k": 323.15, "color": "#000000", "pinned": true },
    { "temperature_k": 299.15, "color": "#777777" },
    { "temperature_k": 299.15, "color": "#000000" },
    { "temperature_k": 283.15, "color": "#5F5F5F" },
    { "temperature_k": 278.15, "color": "#676767" },
    { "temperature_k": 258.15, "color": "#FAFAFA" },
    { "temperature_k": 253.15, "color": "#BF00FF" },
    { "temperature_k": 245.15, "color": "#0000FF" },
    { "temperature_k": 245.15, "color": "#000DF1" },
    { "temperature_k": 243.15, "color": "#0028D6" },
    { "temperature_k": 228.15, "color": "#00F40B" },
    { "temperature_k": 228.15, "color": "#03FF00" },
    { "temperature_k": 218.15, "color": "#EDFF00" },
    { "temperature_k": 218.15, "color": "#FFF900" },
    { "temperature_k": 208.15, "color": "#FF1100" },
    { "temperature_k": 208.15, "color": "#F90000" },
    { "temperature_k": 198.15, "color": "#100000" },
    { "temperature_k": 198.15, "color": "#0D0D0D" },
    { "temperature_k": 183.15, "color": "#A0A0A0" },
    { "temperature_k": 173.15, "color": "#FFFFFF" }
  ]
});
