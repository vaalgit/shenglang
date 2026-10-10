# 聲浪

在電動車（Tesla 車機瀏覽器）上即時合成燃油引擎聲的網頁 App。

- 五種引擎：直列五缸、水平對臥六缸、直列六缸雙渦輪、V8、直列四缸
- 自排／手排，方向盤上一首／下一首可以換檔
- 速度來源：GPS（實車）或模擬油門（試聽）
- 不用安裝、不用帳號，一個 `index.html` 就能跑

## 在車上使用

1. 開啟 GitHub Pages 後，在車機瀏覽器打開 `https://<帳號>.github.io/<repo 名稱>/`
2. 選「GPS」模式，允許使用位置，按「發動引擎」
3. 看上方 GPS 狀態：會顯示每秒幾筆；若顯示「座標推算」，代表瀏覽器沒給速度，反應會慢一點

## 檔案

| 路徑 | 內容 |
|---|---|
| `index.html` | 組好的成品，直接架站用 |
| `src/dsp.js` | 引擎聲合成（逐缸點火、排氣共振、渦輪、回火） |
| `src/engines.js` | 五種引擎的參數與齒比 |
| `src/app.js` | GPS 卡爾曼濾波、變速箱邏輯、介面 |
| `src/shell.html` | 介面版面與樣式 |
| `build.py` | 改完 `src/` 後執行，重新產生 `index.html` |
| `test/` | 用模擬 GPS 驅動 App 的自動測試 |

## 測試

需要 Node.js 和 Python 3。

```bash
cd test
node harness.js i5 10 yes runs/demo 7   # 引擎 GPS頻率 有無速度欄位 輸出檔名 亂數種子
python3 check.py runs/demo.json         # 12 項檢查
python3 matrix.py                       # 8 種設定 × 10 組雜訊
```
