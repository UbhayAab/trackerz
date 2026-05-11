export function usd(value) {
  return `$${value.toFixed(2)}`;
}

export function inr(value) {
  return `Rs ${Number(value).toLocaleString("en-IN")}`;
}

export function percent(value) {
  return `${Math.round(value * 100)}%`;
}
