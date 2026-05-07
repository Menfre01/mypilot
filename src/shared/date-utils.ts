export function getLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 获取本周一的本地日期字符串（周一为一周起始） */
export function getWeekStart(date = new Date()): string {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const diff = day === 0 ? 6 : day - 1; // 距周一的天数
  d.setDate(d.getDate() - diff);
  return getLocalDate(d);
}

/** 获取本月1号的本地日期字符串 */
export function getMonthStart(date = new Date()): string {
  const d = new Date(date);
  d.setDate(1);
  return getLocalDate(d);
}
