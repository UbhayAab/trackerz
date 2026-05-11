export function normalizeStatementRow(row, mapping) {
  const debit = Number(row[mapping.debit] || 0);
  const credit = Number(row[mapping.credit] || 0);
  const signedAmount = mapping.amount ? Number(row[mapping.amount] || 0) : credit - debit;
  return {
    date: row[mapping.date] ?? null,
    description: row[mapping.description] ?? "",
    debit: debit || (signedAmount < 0 ? Math.abs(signedAmount) : 0),
    credit: credit || (signedAmount > 0 ? signedAmount : 0),
    balance: mapping.balance ? Number(row[mapping.balance] || 0) : null,
    reference: mapping.reference ? row[mapping.reference] ?? "" : "",
  };
}
