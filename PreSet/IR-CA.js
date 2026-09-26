/* 预置色标「IR-CA」：一个文件一条预置（文件名 = name）。
   下面这段就是一条色标 JSON（与「另存为」导出的格式一致，只是不带 created ——
   导入时才按当前时间生成）。改完不用动 index.html；
   新增 / 删除预置请同步改 PreSet/manifest.js 的清单。 */
(window.IR_PRESETS = window.IR_PRESETS || []).push({
  "name": "IR-CA",
  "nodes": [
    { "temperature_k": 323.15, "color": "#880000", "pinned": true },
    { "temperature_k": 313.15, "color": "#020000" },
    { "temperature_k": 301.15, "color": "#010101" },
    { "temperature_k": 293.15, "color": "#1E1E1E" },
    { "temperature_k": 282.15, "color": "#676667" },
    { "temperature_k": 278.15, "color": "#002A46" },
    { "temperature_k": 278.15, "color": "#0B3449" },
    { "temperature_k": 258.15, "color": "#174E75" },
    { "temperature_k": 242.15, "color": "#088294" },
    { "temperature_k": 231.15, "color": "#16C26E" },
    { "temperature_k": 219.15, "color": "#77FC02" },
    { "temperature_k": 213.15, "color": "#F6EA00" },
    { "temperature_k": 213.15, "color": "#F1EF00" },
    { "temperature_k": 203.15, "color": "#FD4D00" },
    { "temperature_k": 203.15, "color": "#FF4100" },
    { "temperature_k": 197.15, "color": "#D20E11" },
    { "temperature_k": 197.15, "color": "#C6241D" },
    { "temperature_k": 193.15, "color": "#B94F7C" },
    { "temperature_k": 193.15, "color": "#B75292" },
    { "temperature_k": 192.15, "color": "#AB62D2" },
    { "temperature_k": 192.15, "color": "#AF6AEB" },
    { "temperature_k": 188.15, "color": "#583CB6" },
    { "temperature_k": 188.15, "color": "#5138BE" },
    { "temperature_k": 183.15, "color": "#C4CDFF" },
    { "temperature_k": 183.15, "color": "#C6C6FF" },
    { "temperature_k": 173.15, "color": "#FDFDFF" }
  ]
});
