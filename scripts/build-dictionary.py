#!/usr/bin/env python3
"""
從 ECDICT 建立精簡英漢詞典。

為什麼需要詞典而不是機器翻譯：
  MT 引擎（Chrome 內建 Translator）對單一個字只會回**一個**它猜的意思，
  實測 goal → 籃、Hunter → 跡人。詞典則列出**所有義項**（目標／球門／終點），
  使用者自己一眼就能挑對的那個。對語言學習來說詞典本來就比 MT 適合。

來源：https://github.com/skywind3000/ECDICT （MIT）
用法：
  pip3 install opencc-python-reimplemented
  python3 scripts/build-dictionary.py
"""
import csv, json, os, re, sys, urllib.request

# ECDICT 的譯文是簡體，使用者要的是繁體（台灣用語）
# pip3 install opencc-python-reimplemented
import opencc
CONVERT = opencc.OpenCC('s2twp').convert

SRC = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv'
CACHE = '/tmp/ecdict.csv'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'dictionary.json')

# 保留多少常用詞。字幕用語集中在高頻詞，取太多只是讓檔案變大
MAX_RANK = 35000
MAX_SENSES = 4          # 每個字最多保留幾個義項
MAX_LEN = 80            # 翻譯字串上限，避免少數詞條塞爆檔案

if not os.path.exists(CACHE):
    print(f'下載 {SRC} …', file=sys.stderr)
    urllib.request.urlretrieve(SRC, CACHE)

def rank(row):
    """詞頻排名，越小越常用。兩個語料庫取較好的那個"""
    ranks = [int(row[k]) for k in ('frq', 'bnc') if row.get(k, '').isdigit() and int(row[k]) > 0]
    return min(ranks) if ranks else 10 ** 9

# ECDICT 的學科領域標記：[計] 計算機、[法] 法律、[經] 經濟、[醫] 醫學…
# 對看影集學英文來說，標記本身是雜訊 —— 但釋義要留，
# 因為像 promotion 的「[經] 推廣, 推銷」反而是日常最常用的意思。
DOMAIN_TAG = re.compile(r'\[[^\]]{1,4}\]\s*')
POS_PREFIX = re.compile(r'^([a-z]+\.)\s*')


def clean(translation):
    """ECDICT 的 translation 是多行，每行一個詞性的義項"""
    seen = set()
    senses = []

    for line in translation.replace('\\n', '\n').split('\n'):
        line = DOMAIN_TAG.sub('', line).strip()
        if not line:
            continue

        pos = ''
        match = POS_PREFIX.match(line)
        if match:
            pos = match.group(1) + ' '
            line = line[match.end():]

        # 同一個詞常在多組義項裡重複出現（尤其被拿掉領域標記之後），
        # 去重才不會讓有限的長度被重複內容佔滿
        terms = []
        for term in line.split(','):
            term = term.strip()
            if term and term not in seen:
                seen.add(term)
                terms.append(term)

        if terms:
            senses.append(pos + ', '.join(terms))

    text = '；'.join(senses[:MAX_SENSES])
    return CONVERT(text[:MAX_LEN].rstrip('；').rstrip(', '))

words, forms = {}, {}
csv.field_size_limit(10 ** 7)

with open(CACHE, encoding='utf-8') as f:
    for row in csv.DictReader(f):
        word = (row.get('word') or '').strip()
        translation = (row.get('translation') or '').strip()
        if not word or not translation or ' ' in word or not word.isascii():
            continue
        # 核心詞彙（Oxford 3000 / Collins 星級）一律保留，其餘看詞頻
        core = row.get('oxford') == '1' or (row.get('collins') or '0') not in ('', '0')
        if not core and rank(row) > MAX_RANK:
            continue

        key = word.lower()
        text = clean(translation)
        if not text:
            continue
        words[key] = text

        # exchange 欄記錄變化形（p:過去式 d:過去分詞 i:現在分詞 3:三單 s:複數 …）
        # 有了它，字幕裡的 running / ran / goals 都能查回原形
        for part in (row.get('exchange') or '').split('/'):
            if ':' not in part:
                continue
            _, variant = part.split(':', 1)
            variant = variant.strip().lower()
            if variant and variant != key:
                forms.setdefault(variant, key)

# 本身就是詞條的不需要轉導
forms = {k: v for k, v in forms.items() if k not in words}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'words': words, 'forms': forms}, f, ensure_ascii=False, separators=(',', ':'))

size = os.path.getsize(OUT) / 1048576
print(f'✅ {len(words):,} 個詞條、{len(forms):,} 個變化形 → {size:.1f} MB', file=sys.stderr)
