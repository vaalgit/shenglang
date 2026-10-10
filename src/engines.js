const ev = n => Array.from({ length: n }, (_, i) => i / n);
const ENGINES = [
  {
    id: 'i5', name: '直列五缸 2.5 渦輪', note: '奇數缸的不等長排氣，帶出獨特的顫音',
    cyl: 5, layout: '直列 5', power: '400 匹', idle: 880, redline: 7000,
    offsets: [0, 0.206, 0.396, 0.608, 0.797], banks: [0, 0, 0, 0, 0],
    gains: [1, 0.78, 0.93, 0.68, 0.88],
    res: [[110, 4, 1.0], [260, 6, 0.6], [720, 8, 0.25], [1600, 6, 0.12]],
    pipeHz: 135, pipeFb: 0.45, direct: 0.5, noise: 0.25, pulse: 0.45,
    drive: 2.2, bright: 0.6, turbo: 0.8, pops: 1.0, level: 1,
    gears: [3.57, 2.53, 1.68, 1.18, 0.96, 0.8, 0.67], fd: 3.3, box: '七速雙離合'
  },
  {
    id: 'f6', name: '水平對臥六缸 4.0 自然進氣', note: '9000 轉的高亢嘶吼，越拉越尖',
    cyl: 6, layout: '水平對臥 6', power: '510 匹', idle: 950, redline: 9000,
    offsets: ev(6), banks: [0, 1, 0, 1, 0, 1],
    gains: [1, 0.95, 0.98, 0.93, 1, 0.96],
    res: [[180, 5, 0.8], [440, 7, 0.6], [1100, 9, 0.4], [2400, 6, 0.25]],
    pipeHz: 190, pipeFb: 0.35, direct: 0.45, noise: 0.35, pulse: 0.35,
    drive: 2.8, bright: 1.0, turbo: 0, pops: 0.6, level: 1.25,
    gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], fd: 4.47, box: '七速雙離合'
  },
  {
    id: 'i6', name: '直列六缸 3.0 雙渦輪', note: '平順綿密，渦輪哨音和洩壓閥最明顯',
    cyl: 6, layout: '直列 6', power: '320 匹', idle: 800, redline: 6800,
    offsets: ev(6), banks: [0, 0, 0, 0, 0, 0],
    gains: [1, 0.97, 0.99, 0.96, 1, 0.98],
    res: [[120, 5, 1.0], [330, 6, 0.5], [900, 8, 0.25], [2000, 6, 0.1]],
    pipeHz: 150, pipeFb: 0.4, direct: 0.5, noise: 0.2, pulse: 0.5,
    drive: 1.8, bright: 0.5, turbo: 1.0, pops: 0.5, level: 1.1,
    gears: [3.83, 2.36, 1.69, 1.31, 1.0, 0.79], fd: 3.27, box: '六速手排'
  },
  {
    id: 'v8', name: 'V8 4.0 雙渦輪 十字曲軸', note: '左右兩排不規則交錯，低沉的隆隆聲',
    cyl: 8, layout: 'V 型 8', power: '600 匹', idle: 700, redline: 6800,
    offsets: ev(8), banks: [0, 1, 0, 1, 1, 0, 1, 0],
    gains: [1, 0.9, 0.95, 1, 0.85, 0.97, 0.92, 0.88],
    res: [[85, 4, 1.2], [210, 5, 0.7], [520, 7, 0.3], [1300, 6, 0.12]],
    pipeHz: [95, 103], pipeFb: 0.5, direct: 0.55, noise: 0.2, pulse: 0.55,
    drive: 2.0, bright: 0.45, turbo: 0.5, pops: 1.2, level: 2.2,
    gears: [4.71, 3.14, 2.11, 1.67, 1.29, 1.0, 0.84, 0.67], fd: 3.2, box: '八速自排'
  },
  {
    id: 'i4', name: '直列四缸 2.0 渦輪', note: '輕快的鋼砲聲，換檔瞬間「噗」一聲',
    cyl: 4, layout: '直列 4', power: '245 匹', idle: 850, redline: 6700,
    offsets: ev(4), banks: [0, 0, 0, 0],
    gains: [1, 0.95, 1, 0.93],
    res: [[140, 5, 0.9], [380, 6, 0.55], [1000, 8, 0.3], [2200, 6, 0.15]],
    pipeHz: 170, pipeFb: 0.35, direct: 0.5, noise: 0.3, pulse: 0.45,
    drive: 2.4, bright: 0.7, turbo: 0.7, pops: 1.0, level: 1.4, shiftPop: true,
    gears: [3.5, 2.3, 1.6, 1.2, 0.95, 0.78, 0.65], fd: 3.9, box: '七速雙離合'
  }
];
