export function renderTable(columns, rows) {
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
                ${columns
                  .map((column) => {
                    const value = row[column.key] ?? "";
                    const className = column.strong ? "cell-strong" : "";
                    return `<td class="${className}">${formatCell(column, value)}</td>`;
                  })
                  .join("")}
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function formatCell(column, value) {
  if (column.badge) {
    const risk = /risk|review|duplicate|OCR|portion/i.test(String(value)) ? " badge-risk" : "";
    return `<span class="badge${risk}">${value}</span>`;
  }
  return value;
}
