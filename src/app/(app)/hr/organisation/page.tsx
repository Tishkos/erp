import { redirect } from 'next/navigation';

/**
 * Organisation — REQ-HR-001 §5, now the Departments screen (REQ-FIX-001
 * FIX-5): each department's record carries its seats in reporting order and
 * who holds each. The address is kept for anyone who saved it.
 */
export default function OrganisationPage(): never {
  redirect('/hr/departments');
}
