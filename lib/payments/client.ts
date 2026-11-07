/** A fresh id for one payment attempt, in the form the backend accepts. Taken once per review, so a repeat is the same payment. */
export const newPaymentId = () => `pay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
