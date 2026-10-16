// 进度百分比与预估剩余时间:全是估的,依据是这一轮每步的平均用时,或这个部门过去几轮的实际用时
import type { HubStatus } from '../types'

// 没有任何历史时的起步值
export const DEFAULT_TURN_MS = 3 * 60000
export const DEFAULT_STEP_MS = 90000

export type Estimate = { pct: number; remainingMs: number; isOver: boolean }

// 走到预估时间时到 95%;超过之后越走越慢,停在 99% 前,不假装做完
const ease = (x: number) => (x < 1 ? x * 0.95 : 0.95 + 0.04 * (1 - Math.exp(-(x - 1))))

export const estimate = (one: HubStatus, now: number): Estimate | undefined => {
  if (one.state !== 'busy' || !one.since) return undefined
  const elapsed = Math.max(0, now - one.since)
  const plan = one.plan
  if (plan && plan.total > 0) {
    const mark = one.stepMark && one.stepMark >= one.since ? one.stepMark : one.since
    // 这一轮已经做完几步,就用这几步的平均;一步都没做完,用这个部门以往每步的用时
    const stepMs = plan.done > 0 && mark > one.since ? (mark - one.since) / plan.done : one.typicalStepMs || DEFAULT_STEP_MS
    const inStep = Math.max(0, now - mark)
    const left = Math.max(0, plan.total - plan.done)
    const current = left > 0 ? ease(inStep / stepMs) : 0
    const pct = Math.min(0.99, (plan.done + current) / plan.total)
    const remainingMs = left > 0 ? Math.max(0, stepMs - inStep) + stepMs * (left - 1) : 0
    return { pct, remainingMs, isOver: left > 0 && inStep > stepMs }
  }
  const expected = one.typicalTurnMs || DEFAULT_TURN_MS
  return {
    pct: Math.min(0.99, ease(elapsed / expected)),
    remainingMs: Math.max(0, expected - elapsed),
    isOver: elapsed > expected,
  }
}

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export const remainingText = (guess: Estimate) => {
  if (guess.isOver) return '比预估久'
  if (guess.remainingMs < 15000) return '快好了'
  return `约剩 ${duration(guess.remainingMs)}`
}

// 中位数:过去几轮里一两次特别长的不会把预估带偏
export const median = (list: number[]) => {
  if (list.length === 0) return undefined
  const sorted = [...list].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
