"""把 src/ 裡的檔案組成一個可直接架站的 index.html。用法：python3 build.py"""
from pathlib import Path
root = Path(__file__).parent
src = root / 'src'
shell = (src / 'shell.html').read_text(encoding='utf-8')
js = '\n'.join((src / f).read_text(encoding='utf-8') for f in ('dsp.js', 'engines.js', 'app.js'))
html = ('<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        '<meta name="theme-color" content="#111214">\n</head>\n<body>\n'
        + shell + '\n<script>\n' + js + '\n</script>\n</body>\n</html>\n')
(root / 'index.html').write_text(html, encoding='utf-8')
print('index.html 已更新')
