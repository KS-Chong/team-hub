// 指挥台面板在桌面版画成 SVG:深蓝墨 + 中性灰 + 语义色(绿 = 在做、琥珀 = 要你处理、红 = 快用完)
import type { HubHandoff, HubStatus } from '../types'
import { estimate, remainingText } from './estimate'

export const W = 440
const C = {
  ink: '#1E2D3B',
  red: '#B52026',
  text: '#3B3A3A',
  muted: '#6B6B6B',
  subtle: '#757575',
  border: '#C6C6C6',
  line: '#E6E6E6',
  surface: '#FFFFFF',
  bg: '#F7F7F7',
  soft: '#C0D2E5',
  positive: '#1F7A34',
  positiveBg: '#E8F2EA',
  warning: '#8A5A10',
  warningBg: '#F3EEE7',
  softBg: '#E6EDF5',
}
// 部门头像色:按名字固定挑一个,同一个部门永远同一个颜色
const AVATAR = ['#1E2D3B', '#B52026', '#2F5D8A', '#1F7A34', '#8A5A10', '#5B4B8A']
const FONT = "'Segoe UI', 'Microsoft YaHei', 'PingFang SC', system-ui, sans-serif"

export type UsageMeter = { kind: string; percentUsed: number; resetsAt?: string }

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 估字宽:中日韩字约一个字号宽,其余约 0.56 个
const measure = (text: string, size: number) =>
  [...text].reduce((sum, ch) => sum + (/[⺀-￯]/.test(ch) ? size : size * 0.56), 0)

const fit = (text: string, size: number, room: number) => {
  if (measure(text, size) <= room) return text
  let out = ''
  for (const ch of text) {
    if (measure(`${out}${ch}…`, size) > room) break
    out += ch
  }
  return `${out}…`
}

const hue = (name: string) => AVATAR[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR.length]

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">
${body}
</svg>`

const STATE_LABEL: Record<HubStatus['state'], string> = { busy: '工作中', idle: '空闲', offline: '离线' }

const pill = (right: number, y: number, state: HubStatus['state']) => {
  const label = STATE_LABEL[state]
  const width = 26 + measure(label, 12)
  const x = right - width
  const textAt = `x="${x + 19}" y="${y + 15}" font-size="12"`
  if (state === 'busy') {
    return `<rect x="${x}" y="${y}" width="${width}" height="22" rx="11" fill="${C.positiveBg}"/>
<circle cx="${x + 11}" cy="${y + 11}" r="3.5" fill="${C.positive}"><animate attributeName="opacity" values="1;.25;1" dur="1.6s" repeatCount="indefinite"/></circle>
<text ${textAt} font-weight="600" fill="${C.positive}">${label}</text>`
  }
  if (state === 'idle') {
    return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="21" rx="10.5" fill="${C.bg}" stroke="${C.line}"/>
<circle cx="${x + 11}" cy="${y + 11}" r="3.2" fill="none" stroke="${C.subtle}" stroke-width="1.4"/>
<text ${textAt} fill="${C.muted}">${label}</text>`
  }
  return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${width - 1}" height="21" rx="10.5" fill="none" stroke="${C.border}" stroke-dasharray="3 2"/>
<line x1="${x + 8}" y1="${y + 11}" x2="${x + 14}" y2="${y + 11}" stroke="${C.subtle}" stroke-width="1.4"/>
<text ${textAt} fill="${C.subtle}">${label}</text>`
}

// 贴在卡片底边的进度条:工作中按预估平滑往前走;空闲但清单没做完就停在做到的位置
const bar = (one: HubStatus, y: number, height: number, index: number, w = W) => {
  const top = y + height - 5
  const clip = `<clipPath id="card${index}"><rect x="0.5" y="${y + 0.5}" width="${w - 1}" height="${height - 1}" rx="12"/></clipPath>`
  const track = `<rect x="0" y="${top}" width="${w}" height="5" fill="${C.line}"/>`
  const now = Date.now()
  const guess = estimate(one, now)
  let fill = ''
  if (guess) {
    // 每 5 秒重画一次:这一段从现在的位置平滑走到 5 秒后该在的位置
    const from = w * guess.pct
    const to = w * (estimate(one, now + 5000)?.pct ?? guess.pct)
    const color = guess.isOver ? C.warning : C.positive
    fill = `<rect x="0" y="${top}" width="${from}" height="5" fill="${color}"><animate attributeName="width" from="${from}" to="${to}" dur="5s" fill="freeze"/></rect>
<rect x="0" y="${top}" width="${from}" height="5" fill="url(#shine)" opacity=".55"><animate attributeName="width" from="${from}" to="${to}" dur="5s" fill="freeze"/></rect>`
  } else if (one.plan && one.plan.total > 0) {
    fill = `<rect x="0" y="${top}" width="${(w * one.plan.done) / one.plan.total}" height="5" fill="${C.subtle}"/>`
  }
  return `${clip}<g clip-path="url(#card${index})">${track}${fill}</g>`
}

// 右下角:工作中写「62% · 约剩 3 分钟」;空闲写多久以前
const cornerText = (one: HubStatus, ago: string) => {
  const guess = estimate(one, Date.now())
  if (!guess) return one.plan ? `${one.plan.done} / ${one.plan.total} 步 · ${ago}` : ago
  return `${Math.round(guess.pct * 100)}% · ${remainingText(guess)}`
}

const cardHeight = (duty?: string) => (duty ? 86 : 72)

const card = (one: HubStatus, y: number, index: number, isMe: boolean, ago: string, elapsed: string, duty?: string, w = W) => {
  const off = one.state === 'offline'
  const height = cardHeight(duty)
  const name = fit(one.name, 15, w - 68 - 96 - (isMe ? 54 : 0))
  const nameEnd = 68 + measure(name, 15)
  const right = cornerText(one, ago)
  const busyLine = one.state === 'busy' && one.since ? `${elapsed} · ` : ''
  const left =
    one.plan && one.plan.current
      ? `${busyLine}第 ${Math.min(one.plan.done + 1, one.plan.total)}/${one.plan.total} 步：${one.plan.current}`
      : `${busyLine}${one.last || '还没有动作'}`
  const actionY = y + height - 18
  const last = fit(left, 13, w - 68 - 16 - measure(right, 12) - 16)
  const me = isMe
    ? `<rect x="${nameEnd + 8}" y="${y + 17}" width="46" height="18" rx="9" fill="${C.soft}"/>
<text x="${nameEnd + 31}" y="${y + 30}" font-size="11" font-weight="600" fill="${C.ink}" text-anchor="middle">本窗口</text>`
    : ''
  const dutyLine = duty ? `<text x="68" y="${y + 49}" font-size="11.5" fill="${C.subtle}">${esc(fit(duty, 11.5, w - 68 - 16))}</text>` : ''
  return `<g opacity="${off ? 0.6 : 1}">
<rect x="0.5" y="${y + 0.5}" width="${w - 1}" height="${height - 1}" rx="12" fill="${C.surface}" stroke="${isMe ? C.soft : C.line}"/>
<circle cx="36" cy="${y + 36}" r="19" fill="${off ? C.border : hue(one.name)}"/>
<text x="36" y="${y + 41.5}" font-size="15" font-weight="700" fill="#FFFFFF" text-anchor="middle">${esc([...one.name][0] ?? '?')}</text>
<text x="68" y="${y + 31}" font-size="15" font-weight="600" fill="${C.text}">${esc(name)}</text>
${me}
${pill(w - 16, y + 15, one.state)}
${dutyLine}
<text x="68" y="${actionY}" font-size="13" fill="${one.last ? C.muted : C.subtle}">${esc(last)}</text>
<text x="${w - 16}" y="${actionY}" font-size="12" font-weight="${one.state === 'busy' ? 600 : 400}" fill="${one.state !== 'busy' ? C.subtle : estimate(one, Date.now())?.isOver ? C.warning : C.positive}" text-anchor="end">${esc(right)}</text>
${bar(one, y, height, index, w)}
</g>`
}

const dashed = (y: number, height: number, lines: string[]) => {
  const first = y + height / 2 + 5 - (lines.length - 1) * 10
  return `<rect x="0.5" y="${y + 0.5}" width="${W - 1}" height="${height - 1}" rx="12" fill="none" stroke="${C.border}" stroke-dasharray="4 3"/>
${lines
  .map(
    (line, i) =>
      `<text x="${W / 2}" y="${first + i * 20}" font-size="${i === 0 ? 13 : 12}" fill="${i === 0 ? C.muted : C.subtle}" text-anchor="middle">${esc(line)}</text>`,
  )
  .join('\n')}`
}

const section = (y: number, label: string, count?: number) => {
  const labelEnd = 2 + measure(label, 11) + label.length * 1.2
  const countText = count === undefined ? '' : `<text x="${labelEnd + 6}" y="${y}" font-size="11" fill="${C.subtle}">${count}</text>`
  const lineStart = labelEnd + (count === undefined ? 10 : 22)
  return `<text x="2" y="${y}" font-size="11" font-weight="600" letter-spacing="1.2" fill="${C.subtle}">${esc(label)}</text>
${countText}
<line x1="${lineStart}" y1="${y - 4}" x2="${W}" y2="${y - 4}" stroke="${C.line}"/>`
}

// 额度:超过 80% 琥珀、95% 红
export const usageTone = (pct: number) => (pct >= 95 ? 'red' : pct >= 80 ? 'warning' : 'normal')
const USAGE_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '周', spend_limit: '额度' }

export const resetText = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return '重置时间未知'
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  if (minutes < 60) return `${minutes} 分钟后重置`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`
}

// 量条后面的小灰字:离重置还有多久,「2h14m」这样,不写句子
export const shortReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((at - now) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

// 两条小量条:标签、量条、百分比,后面跟一小段离重置还有多久
const meters = (usage: UsageMeter[], y: number) => {
  const shown = usage.filter(one => USAGE_LABEL[one.kind]).slice(0, 2)
  let x = W
  const parts: string[] = []
  for (const one of [...shown].reverse()) {
    const label = USAGE_LABEL[one.kind]
    const pct = Math.round(one.percentUsed)
    const tone = usageTone(one.percentUsed)
    const color = tone === 'red' ? C.red : tone === 'warning' ? C.warning : C.ink
    const pctText = `${pct}%`
    const reset = shortReset(one.resetsAt, Date.now())
    const width = measure(label, 11) + 6 + 64 + 6 + measure(pctText, 11) + (reset ? 4 + measure(reset, 10) : 0)
    x -= width
    const barX = x + measure(label, 11) + 6
    const resetX = barX + 70 + measure(pctText, 11) + 4
    parts.push(`<g><title>${esc(`${label === '周' ? '本周' : label} 额度用了 ${pct}% · ${resetText(one.resetsAt, Date.now())}`)}</title>
<text x="${x}" y="${y}" font-size="11" fill="${C.subtle}">${label}</text>
${reset ? `<text x="${resetX}" y="${y}" font-size="10" fill="${C.subtle}">${reset}</text>` : ''}
<rect x="${barX}" y="${y - 6}" width="64" height="5" rx="2.5" fill="${C.line}"/>
<rect x="${barX}" y="${y - 6}" width="${Math.min(64, (64 * one.percentUsed) / 100)}" height="5" rx="2.5" fill="${color}"/>
<text x="${barX + 70}" y="${y}" font-size="11" font-weight="${tone === 'normal' ? 400 : 600}" fill="${tone === 'normal' ? C.subtle : color}">${pctText}</text>
</g>`)
    x -= 16
  }
  return parts.join('\n')
}

const header = (all: HubStatus[], project: string, usage: UsageMeter[]) => {
  const stats = [
    { n: all.filter(one => one.state === 'busy').length, label: '工作中', color: C.positive },
    { n: all.filter(one => one.state === 'idle').length, label: '空闲', color: C.text },
    { n: all.filter(one => one.state === 'offline').length, label: '离线', color: C.subtle },
  ]
  const parts = [
    `<text x="2" y="16" font-size="11" font-weight="700" letter-spacing="2.2" fill="${C.subtle}">${esc(fit(project.toUpperCase(), 11, 220))}</text>`,
    `<text x="2" y="44" font-size="22" font-weight="700" fill="${C.ink}">指挥台</text>`,
  ]
  let x = W
  for (const stat of [...stats].reverse()) {
    const numberWidth = measure(String(stat.n), 20)
    x -= numberWidth + 4 + measure(stat.label, 11)
    parts.push(`<text x="${x}" y="44" font-size="20" font-weight="700" fill="${stat.color}">${stat.n}</text>
<text x="${x + numberWidth + 4}" y="44" font-size="11" fill="${C.subtle}">${stat.label}</text>`)
    x -= 18
  }
  if (usage.length > 0) parts.push(meters(usage, 68))
  return parts.join('\n')
}

// 上半张:标题、额度、部门卡片(交接队列在下面用真按钮画,才能放 ×)
export const boardSvg = (
  all: HubStatus[],
  me: string,
  ago: (at: number) => string,
  elapsed: (from: number) => string,
  options: { project: string; usage?: UsageMeter[]; duties?: Record<string, string> },
) => {
  const usage = options.usage ?? []
  const parts = [
    // 进度条上一道慢慢扫过的亮光,让它看起来在走
    `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity=".8"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/><animate attributeName="x1" values="-1;1" dur="2.4s" repeatCount="indefinite"/><animate attributeName="x2" values="0;2" dur="2.4s" repeatCount="indefinite"/></linearGradient></defs>`,
    header(all, options.project, usage),
  ]
  let y = usage.length > 0 ? 102 : 82
  const live = all.filter(one => one.state !== 'offline')
  parts.push(section(y, '部门', live.length))
  y += 14
  if (live.length === 0) {
    parts.push(dashed(y, 72, ['还没有部门加入', '在输入框上方的「加入指挥台」选一个部门']))
    y += 82
  }
  for (const [index, one] of live.entries()) {
    const duty = options.duties?.[one.name]
    parts.push(card(one, y, index, one.sessionId === me, ago(one.at), one.since ? elapsed(one.since) : '', duty))
    y += cardHeight(duty) + 10
  }
  return { source: svg(W, y, parts.join('\n')), height: y }
}

// 离线部门的卡片单独一张图(× 按钮画在它右边,所以比面板窄一截)
export const offlineCardSvg = (one: HubStatus, ago: string, width: number, duty?: string) => {
  const height = cardHeight(duty)
  return svg(width, height, card(one, 0, 0, false, ago, '', duty, width))
}

const HANDOFF_LOOK: Record<HubHandoff['status'], { label: string; fg: string; bg: string }> = {
  waiting: { label: '等确认', fg: C.warning, bg: C.warningBg },
  accepted: { label: '已接手', fg: C.ink, bg: C.softBg },
  done: { label: '已完成', fg: C.positive, bg: C.positiveBg },
  declined: { label: '已退回', fg: C.subtle, bg: C.bg },
  withdrawn: { label: '已撤回', fg: C.subtle, bg: C.bg },
}

// 交接队列的一行(× 按钮画在它右边,所以宽度比面板窄一截)
export const handoffRowSvg = (item: HubHandoff, mine: boolean, ago: string, width: number) => {
  const look = HANDOFF_LOOK[item.status]
  const chipWidth = 20 + measure(look.label, 11)
  const route = fit(`${item.from}  →  ${item.to}`, 11, width - 32 - chipWidth - 12)
  const title = fit(item.title, 14, width - 32 - measure(ago, 11) - 12)
  const faded = item.status !== 'waiting' && item.status !== 'accepted'
  return svg(
    width,
    60,
    `<g opacity="${faded ? 0.7 : 1}">
<rect x="0.5" y="0.5" width="${width - 1}" height="59" rx="10" fill="${C.surface}" stroke="${mine && item.status === 'waiting' ? C.warning : C.line}"/>
<text x="16" y="22" font-size="11" fill="${C.subtle}">${esc(route)}</text>
<rect x="${width - 16 - chipWidth}" y="10" width="${chipWidth}" height="18" rx="9" fill="${look.bg}"/>
<text x="${width - 16 - chipWidth / 2}" y="23" font-size="11" font-weight="600" fill="${look.fg}" text-anchor="middle">${look.label}</text>
<text x="16" y="45" font-size="14" font-weight="600" fill="${C.text}">${esc(title)}</text>
<text x="${width - 16}" y="45" font-size="11" fill="${C.subtle}" text-anchor="end">${esc(ago)}</text>
</g>`,
  )
}

export const sectionSvg = (label: string, count: number) => svg(W, 22, section(16, label, count))

export const emptyQueueSvg = () =>
  svg(W, 64, dashed(0, 64, ['还没有交接', '让一个部门「交接给 XX 部门」，就会排在这里']))
