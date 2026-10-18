// 部门之间的交接:一个文件一条,收件的窗口弹提醒,老板按「接手」才开始做
import type { HubHandoff, HubStatus } from '../types'

export const HANDOFF_TOOL = 'handoff'
export const HANDOFF_DONE_TOOL = 'handoff_done'

export const HANDOFF_SPEC = {
  name: HANDOFF_TOOL,
  isDeferred: false,
  description: [
    '把一件事交接给这个项目的另一个部门窗口(例如数据部门做完数据层,把函数和规矩交给代码部门)。',
    '写进交接队列后,对方窗口会弹提醒;老板在那边按「接手」,对方才会开始做。不要在聊天里贴交接内容让老板转述。',
    '只在老板要你交接、或你做完的东西明确需要另一个部门接着做时用。收到交接的窗口不要马上再转交给第三个部门。',
    'body 要能独立看懂:做了什么、对方要用的函数 / 文件 / 字段、必须遵守的规矩、没做完或没核验的部分。',
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '收件部门的名称,照指挥台上的写(例如「前端部门」),写一部分也能认' },
      title: { type: 'string', description: '一句话标题,例如「订单报表的数据层已接上」' },
      body: { type: 'string', description: '交接正文,Markdown' },
    },
    required: ['to', 'title', 'body'],
  },
} as const

export const HANDOFF_DONE_SPEC = {
  name: HANDOFF_DONE_TOOL,
  isDeferred: false,
  description: '把别的部门交给你、你已接手的一条交接标记为做完(编号在接手时的指令里)。只在真的做完、并已向老板汇报时用。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '交接编号,例如 H-20261015-0930-ab12' },
      note: { type: 'string', description: '一句话:做了什么,有没有没核验的部分' },
    },
    required: ['id'],
  },
} as const

const pad = (n: number) => String(n).padStart(2, '0')
const newId = () => {
  const d = new Date()
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `H-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

// 收件部门按名字认:先认完全一样的,再认包含的;认到多个就不猜
export const findDepartment = (all: HubStatus[], me: string, to: string) => {
  const others = all.filter(one => one.sessionId !== me)
  const wanted = to.trim().toLowerCase()
  const exact = others.filter(one => one.name.toLowerCase() === wanted)
  if (exact.length > 0) return { match: exact[0], candidates: exact }
  const partial = others.filter(one => one.name.toLowerCase().includes(wanted) || wanted.includes(one.name.toLowerCase()))
  return { match: partial.length === 1 ? partial[0] : undefined, candidates: partial }
}

// 只拼出一条交接,写文件由调用方做
export const buildHandoff = (
  all: HubStatus[],
  me: { sessionId: string; name: string },
  input: { to?: unknown; title?: unknown; body?: unknown },
  duties: Record<string, string> = {},
): { text: string; item?: HubHandoff } => {
  const to = String(input.to ?? '')
  const title = String(input.title ?? '').trim()
  const body = String(input.body ?? '').trim()
  if (title === '' || body === '') return { text: '交接没写进去:title 和 body 都要写。' }
  const { match, candidates } = findDepartment(all, me.sessionId, to)
  const known = all
    .filter(one => one.sessionId !== me.sessionId)
    .map(one => (duties[one.name] ? `「${one.name}」(${duties[one.name]})` : `「${one.name}」`))
  if (match === undefined) {
    const why = candidates.length > 1 ? `「${to}」同时对上 ${candidates.map(one => `「${one.name}」`).join('、')},不猜` : `没有叫「${to}」的部门`
    return { text: `交接没写进去:${why}。指挥台上现在有:${known.join('、') || '(还没有别的部门报到)'}。` }
  }
  const now = Date.now()
  const item: HubHandoff = {
    id: newId(),
    from: me.name,
    fromSession: me.sessionId,
    to: match.name,
    toSession: match.sessionId,
    title,
    body,
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
  }
  return {
    item,
    text: `已写入交接 ${item.id},收件:${item.to}。对方窗口会弹提醒,老板在那边按「接手」后才会开始做;现在还没有人开始做。`,
  }
}

export const acceptPrompt = (item: HubHandoff) =>
  [
    `【接手交接 ${item.id}】来自 ${item.from}:${item.title}`,
    '',
    item.body,
    '',
    `老板已确认接手。先用三五句说你打算怎么做,然后开始。做完向老板汇报后,调用 handoff_done 把 ${item.id} 标为完成;没核验的部分照实写。`,
  ].join('\n')

// 好几条交接一起接手:按交来的先后放进同一条指令,内容原样不改写,完成时每条各自标记
export const acceptAllPrompt = (items: HubHandoff[]) => {
  const ordered = [...items].sort((a, b) => a.createdAt - b.createdAt)
  const ids = ordered.map(one => one.id).join('、')
  return [
    `【一起接手 ${ordered.length} 条交接】${ids}`,
    '',
    ...ordered.flatMap((one, index) => [`## ${index + 1}. ${one.id} · 来自 ${one.from}:${one.title}`, '', one.body, '']),
    `老板已确认全部接手,要你一起看、一起做。先用三五句说你打算怎么做(哪几条有关联、先做哪条),然后开始。`,
    `做完向老板汇报后,每一条都要调用 handoff_done 标为完成(${ids});没做完的那条不要标,照实说做到哪。`,
  ].join('\n')
}

// 开了指挥台的窗口,每次都会在系统提示里看到这一段:协作规矩由插件自带,项目的 CLAUDE.md 不用再写
// 这个部门已接手、还没标完成的交接:每一轮都提醒,做完了才记得 handoff_done
export type OpenHandoff = { id: string; from: string; title: string; acceptedAgo: string }

const openList = (open: OpenHandoff[]) =>
  open.length === 0
    ? ''
    : [
        '你手上还没完成的交接(老板已按「接手」):',
        ...open.map(one => `- ${one.id}:${one.from} 交来的「${one.title}」,${one.acceptedAgo}接手`),
        '做完、向老板汇报之后,调用 handoff_done 把它标为完成(没核验的部分写进 note);还没做完就照实告诉老板做到哪,不要标。',
      ].join('\n')

export const rulesText = (
  project: string,
  me: string,
  duties: Record<string, string>,
  open: OpenHandoff[] = [],
  asked: { id: string; question: string }[] = [],
) => {
  const list = Object.entries(duties)
    .map(([name, duty]) => `- ${name}${name === me ? '(就是你)' : ''}:${duty || '(没写分工)'}`)
    .join('\n')
  return [
    `# ${project} 指挥台:多窗口协作`,
    `这个项目同时开了几个 Claude 窗口,一个窗口一个部门。你是「${me}」。各管各的,不越界改别人的部分。`,
    list ? `部门与分工:\n${list}` : '',
    '- 要另一个部门接着做时,用 handoff 工具写进交接队列;不要在聊天里写「下面这段可以转给 X」让老板转述。正文要能独立看懂:做了什么、对方要用的函数 / 文件 / 字段、必须遵守的规矩、没做完或没核验的部分。',
    '- 收到交接:老板在指挥台按「接手」后才开始,先用三五句说打算怎么做;做完向老板汇报后调用 handoff_done。收到的交接不要马上再转给第三个部门。',
    '- 三步以上的任务先用 TodoWrite 列步骤清单,做一步勾一步 —— 指挥台的进度条和剩余时间靠它估。',
    '- 「做完」分层说:本地改好 / 测试通过 / 已提交 / 已推送 / 已部署是不同的事,分开讲;没做的照实说没做,不说「应该已经」。',
    '- 需要老板拍板才做得下去时(几个方案选一个、要不要做、怎么取舍),用 ask_decision 登记到「等你决定」,然后停下来等;老板在聊天里直接回答了,就用 close_decision 把它拿掉。',
    openList(open),
    asked.length === 0
      ? ''
      : ['你登记了、老板还没回答的问题:', ...asked.map(one => `- ${one.id}:${one.question}`)].join('\n'),
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------- 等老板决定的事 ----------

export const DECISION_TOOL = 'ask_decision'
export const DECISION_CLOSE_TOOL = 'close_decision'

export const DECISION_SPEC = {
  name: DECISION_TOOL,
  isDeferred: false,
  description: [
    '把一个需要老板拍板的问题登记到指挥台的「等你决定」(例如几个方案选一个、要不要做、怎么取舍)。',
    '老板可能不在这个窗口,登记了才不会被埋在聊天里。登记后就停下来等,不要自己替老板选;老板在面板上回答后,答案会作为一条新消息送回这个窗口。',
    '只登记真的要老板决定、而且你没有答案就做不下去的事;一般的确认、进度汇报不要登记。',
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '一句话问题,老板不看上下文也能懂,例如「左栏分组标题用 A / B / C 哪一版?」' },
      options: { type: 'array', items: { type: 'string' }, description: '可选的答案(2–4 个,每个尽量短,例如「B:深蓝墨加粗」);没有固定选项就不填' },
      context: { type: 'string', description: '可选:一两句背景、你的推荐和理由' },
    },
    required: ['question'],
  },
} as const

export const DECISION_CLOSE_SPEC = {
  name: DECISION_CLOSE_TOOL,
  isDeferred: false,
  description: '老板已经在聊天里直接回答了你登记的问题、或者这个问题不用再问了,用这个把它从「等你决定」里拿掉。',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: '问题编号,例如 D-20261016-1030-ab12' } },
    required: ['id'],
  },
} as const

export const newDecisionId = () => {
  const d = new Date()
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `D-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

export const answerPrompt = (question: string, answer: string, id: string) =>
  [`【老板的决定 ${id}】你问:「${question}」`, `老板选:${answer}`, '', '照这个决定继续做;做之前先用一两句说你接下来要做什么。'].join('\n')
