import { redirect } from 'next/navigation';

/**
 * There is no combined Business Partners list any more.
 *
 * There was one, and it was a trap: it showed every partner but offered no way
 * to add one, because adding a partner means giving them a role and this
 * screen did not know which. Someone who opened it to create a customer found
 * a list and no button.
 *
 * A partner is created as a **customer** or as a **supplier**, on the screen
 * that names the role — and adding a company that already exists in the other
 * role grants it the second role rather than making a second record (§6, §3.1).
 * So the two role screens are the whole story, and this address forwards to
 * one of them rather than standing as a third, emptier way in.
 *
 * Legacy bookmarks are forwarded to the Sales customer list. Records are
 * opened from the role-specific Sales or Purchasing list.
 */
export default function BusinessPartnersIndex() {
  redirect('/sales/customers');
}
