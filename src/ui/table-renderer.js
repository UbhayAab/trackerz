export function renderTable(columns, rows, options = {}) {
  return `
    <table class="data-table">
      <thead>
        <tr>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                ${columns.map((column) => renderCell(column, row, options)).join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function renderCell(column, row, options) {
  const value = row[column.key] ?? "";
  const className = column.strong ? "cell-strong" : "";
  if (column.actions) {
    return `<td>${column.actions
      .map(
        (action) =>
          `<button class="table-action" type="button" data-table="${options.table || ""}" data-action="${action.action}" data-row-id="${escapeHtml(row.id)}">${escapeHtml(action.label)}</button>`,
      )
      .join("")}</td>`;
  }
  return `<td class="${className}">${formatCell(column, value)}</td>`;
}

function formatCell(column, value) {
  if (column.badge) {
    const risk = /risk|review|duplicate|OCR|portion/i.test(String(value)) ? " badge-risk" : "";
    return `<span class="badge${risk}">${escapeHtml(value)}</span>`;
  }
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
