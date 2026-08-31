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
 * The record page below this path stays: `/master-data/business-partners/CODE`
 * is where both screens open a partner, because there is one record behind
 * both of them.
 */
export default function BusinessPartnersIndex() {
  redirect('/master-data/customers');
}
