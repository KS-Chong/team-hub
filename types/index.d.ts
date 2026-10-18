// 一个窗口的步骤清单:AI 用 TodoWrite / TaskCreate 列出来的,mod 照抄,不估算
export type HubStep = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }

export type HubPlan = { done: number; total: number; current: string }

export type HubStatus = {
  sessionId: string
  name: string
  state: 'busy' | 'idle' | 'offline'
  last: string
  at: number
  // 心跳:窗口还开着就每 30 秒更新一次;超过 3 分钟没更新就当离线
  seen?: number
  // 这一轮从什么时候开始工作(只在工作中时有)
  since?: number
  // 有步骤清单时才有
  plan?: HubPlan
  // 上一次有步骤做完的时间(算这一轮每步平均用时)
  stepMark?: number
  // 这个部门过去几轮 / 每步的用时中位数(算预估剩余时间)
  typicalTurnMs?: number
  typicalStepMs?: number
  // 这一轮老板交代的事(第一句的开头),做完时拿来写通知
  task?: string
  // 上一次做完一轮长活:其他窗口看到就提醒老板「XX 部门做完了」
  lastDone?: { at: number; ms: number; task: string }
  // 老板在离线卡片上按 × 收起的时间;那个窗口又开工(重新报到)就自动回来
  hiddenAt?: number
}

// 等老板拍板的事:AI 用 ask_decision 登记,面板最上面列出来,老板回答后把答案送回那个窗口
export type HubDecision = {
  id: string
  from: string
  fromSession: string
  question: string
  options: string[]
  context?: string
  // open = 等老板;answered = 老板在面板上回答了(答案还要送回去);delivered = 已送回那个窗口;closed = 在聊天里答过 / 不用答了
  status: 'open' | 'answered' | 'delivered' | 'closed'
  answer?: string
  createdAt: number
  updatedAt: number
}

// 一次交接:一个文件一条,存在看板的 queue/<id>.json
export type HubHandoff = {
  id: string
  from: string
  fromSession: string
  to: string
  toSession: string
  title: string
  body: string
  // waiting = 等老板在对方窗口按「接手」;accepted = 已开始做;done = 做完;declined = 老板不接;withdrawn = 发出的部门撤回
  status: 'waiting' | 'accepted' | 'done' | 'declined' | 'withdrawn'
  createdAt: number
  updatedAt: number
  note?: string
  // 从队列里清掉的时间:面板不再显示,文件留着当存档(插件删不了文件)
  clearedAt?: number
}

// 一个项目的看板:有这个文件 = 这个项目开了指挥台
export type HubBoard = {
  project: string
  root: string
  createdAt: number
  // 部门名称 → 一句话分工
  departments: Record<string, { duty: string }>
}

declare module 'claude-code' {
  interface PluginState {
    'team-hub': {
      tick: number
      name: string
      last: string
      since: number
      steps: HubStep[]
      stepMark: number
      notified: string[]
      task: string
      stale: boolean
      doneSeen: Record<string, number>
      removing: string
      batchOpen: boolean
    }
  }
}
