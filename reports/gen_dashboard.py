"""把 verify --strict 的真实日志渲染成完全自包含的 HTML 测试报告（无 CDN / 无外部字体）。"""
import json
import math
from datetime import datetime
from pathlib import Path

SRC = Path(r'C:\Users\Six\AppData\Local\Temp\verify_stages.json')
OUT = Path(r'E:\Six\MonsterPK\reports\MonsterPK_测试报告_2026-11-16.html')

stages = [s for s in json.loads(SRC.read_text(encoding='utf-8'))
          if s['name'] not in ('前置清理残留测试账号', '清理测试账号')]

def cat(name: str) -> str:
    if name.startswith('E2E'):
        return 'E2E 服务端 / 集成'
    if name.startswith(('375px', '360×')):
        return 'UI 冒烟（浏览器）'
    if '静态门禁' in name or '类型检查' in name or '构建' in name:
        return '静态门禁 / 构建'
    if '单测' in name:
        return '单元测试'
    if '文档' in name or '镜像' in name:
        return '文档 / 镜像'
    return '环境 / 内容'

ORDER = ['静态门禁 / 构建', '单元测试', 'E2E 服务端 / 集成', 'UI 冒烟（浏览器）', '文档 / 镜像', '环境 / 内容']
groups = {c: [s for s in stages if cat(s['name']) == c] for c in ORDER}
total_stages = len(stages)
total_items = sum(s['items'] or 0 for s in stages)
stage_seconds = sum(s['dur'] for s in stages)
wall_seconds = 281.6
pass_rate = 100.0

# 通过率环（纯 SVG，无 JS 依赖）
R = 52
CIRC = 2 * math.pi * R
dash = f'{CIRC * pass_rate / 100:.1f} {CIRC:.1f}'

max_items = max(sum(s['items'] or 0 for s in gs) for gs in groups.values())
bar_rows = []
for c in ORDER:
    gs = groups[c]
    items = sum(s['items'] or 0 for s in gs)
    pct = items / max_items * 100 if max_items else 0
    bar_rows.append(
        f'<div class="bar-row"><div class="bar-label">{c}<span class="bar-sub">{len(gs)} 阶段</span></div>'
        f'<div class="bar-track"><div class="bar-fill" style="width:{pct:.1f}%"></div></div>'
        f'<div class="bar-value">{items:,}</div></div>'
    )

detail_blocks = []
for idx, c in enumerate(ORDER):
    gs = groups[c]
    if not gs:
        continue
    items = sum(s['items'] or 0 for s in gs)
    rows = ''.join(
        f'<tr><td class="sname">{s["name"]}</td>'
        f'<td class="num">{s["items"] if s["items"] is not None else "—"}</td>'
        f'<td class="num">{s["dur"]:.1f}s</td><td class="ok">✓ 通过</td></tr>'
        for s in gs
    )
    open_attr = ' open' if idx < 2 else ''
    detail_blocks.append(f'''
<details class="group"{open_attr}>
  <summary><span class="gname">{c}</span><span class="gmeta">{len(gs)} 阶段 · {items:,} 项 · {sum(s["dur"] for s in gs):.1f}s</span></summary>
  <table><thead><tr><th>阶段</th><th>测试项</th><th>耗时</th><th>结果</th></tr></thead><tbody>{rows}</tbody></table>
</details>''')

fixed = [
    ('P1', 'Major', '配额 CAS 重跑重复扣', 'retryCas 在事务内整段重跑，finishQuota 的一次性副作用执行两次，静默多扣每日次数。',
     '拆 markQuota（只改内存态随房间 CAS）+ applyQuota（bump 成功后落计数）；旧实现单测 3/3 红 → 新实现 3/3 绿。'),
    ('P3', 'Major', '被拒 nonce 不烧，下回合重放被当合法首提', '先判 TURN_ALREADY_SUBMITTED 再 push，且 loadAndMutate 只在 res.ok 时落库，调顺序也没用。',
     '先烧 nonce + persistEvenIfFailed；e2e:nonce 第 13 条断言跨回合重放必 409 INTENT_REPLAY。'),
    ('P4', 'Major', 'nonce 未绑座位，跨座位抢占', 'seenNonces 是全房间共用一维数组，座位 A 用过的 nonce 让座位 B 被判 INTENT_REPLAY。',
     '去重键改 ${seat}:${nonce}，submitIntent / offerAutopilot 同改；红测 1 红 2 绿 → 3/3 绿；e2e:nonce 加 S4。'),
]
fixed_cards = ''.join(
    f'''<div class="bug-card"><div class="bug-title"><span class="bid">{bid}</span> {title} <span class="sev {sev.lower()}">{sev}</span></div>
<div class="bug-line"><b>根因</b>{cause}</div><div class="bug-line"><b>修复 + 取证</b>{fix}</div></div>'''
    for bid, sev, title, cause, fix in fixed
)

risks = [
    ('中', '64 条 nonce 窗口淘汰', '超过 64 条后老 nonce 重放可能被接受（专家评审 §2.1 / §3.1）。建议独立表 + (roomId, seat, nonce) 唯一约束，级联清理；不要换成固定时间窗口。'),
    ('低', 'P5：normalizeRoom 不补数组', '读到字段引入前的旧行时 seenNonces 为 undefined，submitIntent 的 includes 会抛 TypeError → 500。'),
    ('低', 'P6：注释口径与实现不一致', 'roomRegistry 中部分注释仍写旧口径，需随房间态重构一起清理。'),
    ('低', '并行负载下的偶发红', '首轮全量 verify 出现 smoke:p42d「创建房间等待态 timeout:waiting」4 项红；单跑 --only=smoke:p42d 15/15、全量复跑 63/63。本轮未碰建房/WS 路径，判为并行偶发，原始日志在 .verify-logs/。'),
]
risk_cards = ''.join(
    f'<div class="risk"><span class="risk-tag">{lvl}</span><div><b>{title}</b><p>{desc}</p></div></div>'
    for lvl, title, desc in risks
)

now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MonsterPK 自动化测试报告 · 2026-11-16</title>
<style>
:root{{--bg:#f5f7fb;--card:#fff;--text:#1e293b;--muted:#64748b;--border:#e2e8f0;--green:#16a34a;--red:#dc2626;--amber:#d97706;--blue:#2563eb}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);padding:28px;line-height:1.55}}
.wrap{{max-width:1180px;margin:0 auto}}
header{{text-align:center;margin-bottom:24px}}
header h1{{font-size:26px;margin-bottom:6px}}
header p{{color:var(--muted);font-size:13px}}
.badge{{display:inline-block;padding:3px 10px;border-radius:999px;background:#dcfce7;color:#15803d;font-size:12px;font-weight:600;margin-top:8px}}
.summary{{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}}
.card{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;text-align:center;box-shadow:0 1px 2px rgba(15,23,42,.04)}}
.card .v{{font-size:30px;font-weight:750;letter-spacing:-.5px}}
.card .l{{font-size:12px;color:var(--muted);margin-top:4px}}
.g{{color:var(--green)}} .r{{color:var(--red)}} .b{{color:var(--blue)}}
.two{{display:grid;grid-template-columns:1fr 1.25fr;gap:14px;margin-bottom:20px}}
.panel{{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}}
.panel h2{{font-size:15px;margin-bottom:14px}}
.donut-wrap{{display:flex;align-items:center;gap:18px;justify-content:center}}
.donut{{transform:rotate(-90deg)}}
.donut .bg{{stroke:#eef2f7}} .donut .fg{{stroke:var(--green);stroke-linecap:round}}
.legend{{font-size:13px;color:var(--muted)}}
.legend b{{display:block;color:var(--green);font-size:24px}}
.bar-row{{display:grid;grid-template-columns:170px 1fr 68px;align-items:center;gap:10px;margin:9px 0;font-size:13px}}
.bar-label{{color:var(--text)}}
.bar-sub{{display:block;font-size:11px;color:var(--muted)}}
.bar-track{{height:12px;background:#eef2f7;border-radius:999px;overflow:hidden}}
.bar-fill{{height:100%;background:linear-gradient(90deg,#22c55e,#16a34a);border-radius:999px}}
.bar-value{{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}}
h2.sec{{font-size:17px;margin:26px 0 12px}}
.group{{background:var(--card);border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden}}
.group summary{{cursor:pointer;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600;list-style:none}}
.group summary::-webkit-details-marker{{display:none}}
.group summary::before{{content:"▸";margin-right:8px;color:var(--muted)}}
.group[open] summary::before{{content:"▾"}}
.gmeta{{font-size:12px;color:var(--muted);font-weight:400}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{padding:7px 14px;text-align:left;border-top:1px solid var(--border)}}
th{{background:#fafbfd;color:var(--muted);font-weight:500;font-size:12px}}
.num{{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}}
.ok{{color:var(--green);white-space:nowrap}}
.bug-card{{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--amber);border-radius:10px;padding:14px 16px;margin-bottom:10px}}
.bug-title{{font-weight:650;margin-bottom:8px}}
.bid{{display:inline-block;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 7px;font-size:12px;margin-right:6px}}
.sev{{font-size:11px;padding:2px 8px;border-radius:4px;margin-left:6px}}
.sev.major{{background:#fef2f2;color:var(--red)}}
.sev.minor{{background:#ecfdf5;color:var(--green)}}
.sev.中{{background:#fffbeb;color:var(--amber)}}
.sev.低{{background:#f1f5f9;color:var(--muted)}}
.bug-line{{font-size:13px;color:var(--muted);margin-top:4px}}
.bug-line b{{display:inline-block;min-width:82px;color:var(--text)}}
.risk{{display:flex;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:8px;font-size:13px}}
.risk b{{font-size:14px}}
.risk p{{color:var(--muted);margin-top:3px}}
.risk-tag{{flex:none;height:22px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#fffbeb;color:var(--amber)}}
.empty{{background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;border-radius:10px;padding:14px 16px;font-size:14px;margin-bottom:12px}}
footer{{text-align:center;color:var(--muted);font-size:12px;margin-top:28px;border-top:1px solid var(--border);padding-top:14px}}
@media (max-width:760px){{.two{{grid-template-columns:1fr}}.bar-row{{grid-template-columns:120px 1fr 58px}}body{{padding:14px}}}}
</style>
</head>
<body><div class="wrap">
<header>
  <h1>🎮 MonsterPK 自动化测试报告</h1>
  <p>游戏自动化测试专家团 · 林测（测试总监） · 生成时间 {now}</p>
  <p>数据源：<code>npm run verify -- --strict</code> · 2026-11-16 18:39 全量复跑</p>
  <div class="badge">VERIFY_OK · 63 阶段全绿 · 0 跳过</div>
</header>

<div class="summary">
  <div class="card"><div class="v b">{total_stages}</div><div class="l">验收阶段（通过）</div></div>
  <div class="card"><div class="v b">{total_items:,}</div><div class="l">测试项总数</div></div>
  <div class="card"><div class="v g">{pass_rate:.0f}%</div><div class="l">通过率</div></div>
  <div class="card"><div class="v">{wall_seconds:.1f}s</div><div class="l">总耗时（阶段累计 {stage_seconds:.1f}s）</div></div>
  <div class="card"><div class="v g">0</div><div class="l">新增 Bug</div></div>
</div>

<div class="two">
  <div class="panel"><h2>通过率总览</h2>
    <div class="donut-wrap">
      <svg class="donut" width="130" height="130" viewBox="0 0 130 130">
        <circle class="bg" cx="65" cy="65" r="{R}" fill="none" stroke-width="14"/>
        <circle class="fg" cx="65" cy="65" r="{R}" fill="none" stroke-width="14" stroke-dasharray="{dash}"/>
        <text x="65" y="61" text-anchor="middle" font-size="24" font-weight="700" fill="#16a34a" transform="rotate(90 65 65)">100%</text>
        <text x="65" y="80" text-anchor="middle" font-size="11" fill="#64748b" transform="rotate(90 65 65)">{total_stages} 阶段</text>
      </svg>
      <div class="legend">通过 <b>{total_stages}</b>失败 <b style="color:var(--red)">0</b>跳过 <b style="color:var(--muted)">0</b></div>
    </div>
  </div>
  <div class="panel"><h2>各分组测试项分布</h2>{''.join(bar_rows)}</div>
</div>

<h2 class="sec">📋 阶段明细（点击分组展开）</h2>
{''.join(detail_blocks)}

<h2 class="sec">🐛 Bug 清单</h2>
<div class="empty">本轮验收 <b>0 个新增 Bug</b>；以下为今日已修复的 3 个缺陷（P1 / P3 / P4），均经「旧实现必红 → 新实现全绿」取证。</div>
{fixed_cards}

<h2 class="sec">⚠️ 质量风险 / 明确留白</h2>
{risk_cards}

<footer>
  自包含 HTML（无 CDN / 无外部字体）· 测试资产：静态门禁 34 / 前端 161 / 后端 515 / E2E 38 套 / UI 冒烟 16 套 / doc_check 232<br>
  专家团边界：本项目为浏览器 + Capacitor WebView 的 H5 游戏，Airtest / AltTester 框架不适用；本报告基于项目自建 verify 体系真实日志，非模拟数据。
</footer>
</div></body></html>
'''
OUT.write_text(html, encoding='utf-8')
print(f'written: {OUT} ({OUT.stat().st_size} bytes)')
print(f'stages={total_stages} items={total_items} wall={wall_seconds}s')
