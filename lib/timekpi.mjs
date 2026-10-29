// 퍼널 전환 시간 차트(extraCsv의 "중앙값(ms),값")를 카드 숫자로 붙인다. 해석·갱신이 summary를 다시 써도 같은 값이 남게 한 곳에서 만든다.
const LABEL = '첫 실행까지 걸린 시간 (중앙값)';
const ms = v => (v >= 60000 ? `${Math.floor(v / 60000)}분 ${Math.round((v % 60000) / 1000)}초` : `${Math.round(v / 100) / 10}초`);
export function withTimeKpi(summary, extraCsv) {
  const csv = extraCsv && extraCsv['첫 실행까지 시간'];
  const med = csv && (/^중앙값\(ms\),(\d+(?:\.\d+)?)/m.exec(csv) || [])[1];
  if (!med || !summary || !Array.isArray(summary.kpis)) return summary;
  return { ...summary, kpis: [...summary.kpis.filter(k => k.l !== LABEL), { v: ms(Number(med)), l: LABEL, s: '낮을수록 좋아요' }] };
}
