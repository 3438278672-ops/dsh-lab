/**
 * 关系图时间切片：把「全部 / 本周 / 上周 / 本月」翻译成 buildGraph 需要的时间窗。
 *
 * 为什么不用 UTC：群聊的时间感是「今晚」「上周末」，跨零点、跨周一必须按本地时区划，
 * 否则周日深夜的互动会被算到「上周」，图会让人看不懂。
 */

import { fmtDay } from './report.mjs'

export const GRAPH_RANGES = ['all', 'week', 'lastweek', 'month']

const LABELS = {
  all: '全部时间',
  week: '本周',
  lastweek: '上周',
  month: '本月',
}

function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 周一 = 0（周日是 6），和国内「本周一」的口径一致 */
function daysSinceMonday(d) {
  return (d.getDay() + 6) % 7
}

/**
 * @param {'all'|'week'|'lastweek'|'month'} range
 * @param {Date} [now]
 * @returns {{range:string,label:string,fromTs:number,toTs:number,fromDate:string,toDate:string}}
 *   fromTs 含、toTs 不含；all 的 fromTs/toTs 都是 0（表示不设边界）。
 */
export function graphRangeBounds(range = 'all', now = new Date()) {
  const key = GRAPH_RANGES.includes(range) ? range : 'all'
  const today = startOfDay(now)
  // 图的右边界始终是「现在之后一秒」，让 toTs 成为开区间的同时不丢刚发的消息
  const endTs = Math.floor(now.getTime() / 1000) + 1

  if (key === 'all') {
    return { range: 'all', label: LABELS.all, fromTs: 0, toTs: 0, fromDate: '', toDate: '' }
  }

  if (key === 'week') {
    const from = new Date(today)
    from.setDate(from.getDate() - daysSinceMonday(today))
    return {
      range: 'week',
      label: LABELS.week,
      fromTs: Math.floor(from.getTime() / 1000),
      toTs: endTs,
      fromDate: fmtDay(from),
      toDate: fmtDay(now),
    }
  }

  if (key === 'lastweek') {
    const monday = new Date(today)
    monday.setDate(monday.getDate() - daysSinceMonday(today))
    const from = new Date(monday)
    from.setDate(from.getDate() - 7)
    return {
      range: 'lastweek',
      label: LABELS.lastweek,
      fromTs: Math.floor(from.getTime() / 1000),
      toTs: Math.floor(monday.getTime() / 1000),
      fromDate: fmtDay(from),
      toDate: fmtDay(new Date(monday.getTime() - 86400000)),
    }
  }

  const from = new Date(today.getFullYear(), today.getMonth(), 1)
  return {
    range: 'month',
    label: LABELS.month,
    fromTs: Math.floor(from.getTime() / 1000),
    toTs: endTs,
    fromDate: fmtDay(from),
    toDate: fmtDay(now),
  }
}
