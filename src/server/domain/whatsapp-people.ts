/**
 * Who is in the group, and how to speak of them — by direction, 2026-10-05:
 * "it couldn't actually tag the person and read everyone's name".
 *
 * WhatsApp does not put a name in a message. A tag is `@` and a run of digits
 * in the text — these days an opaque id (a "LID"), not even the phone number —
 * with the address it stands for beside it in the message's metadata; the
 * reader's phone draws the name. So:
 *
 *   * a message that tags somebody arrives as "explain that for
 *     @159386907476204", and unless those digits are turned back into a
 *     person, Noah has no idea who was meant;
 *   * and when he writes "@159386907476204" back without the address beside
 *     it, WhatsApp draws the digits — which is exactly what the group saw.
 *
 * The roster is the one registered group's member list and nothing wider: the
 * bridge is linked to a person's own account, and nobody outside that group is
 * ever named here. A member is called by their ERP name when their number is
 * linked to a user, by what WhatsApp shows for a number on the expected list
 * otherwise, and by the number when there is nothing else.
 *
 * Pure: lists in, text out.
 */

export interface Member {
  /** Their number, when WhatsApp gave it. */
  readonly e164: string | null;
  /** Every address WhatsApp uses for them: `<lid>@lid`, `<number>@s.whatsapp.net`. */
  readonly jids: readonly string[];
  /** The address to tag them with: how this group addresses them. */
  readonly tag: string;
  /** What to call them. */
  readonly name: string;
  /** The ERP user their number is linked to, if any. */
  readonly user: { readonly displayName: string; readonly email: string } | null;
}

/** One participant as WhatsApp lists it: whichever of these it happened to fill in. */
export interface Participant {
  readonly id?: unknown;
  readonly lid?: unknown;
  readonly phoneNumber?: unknown;
  readonly jid?: unknown;
  readonly notify?: unknown;
  readonly name?: unknown;
}

const userPart = (jid: string) => jid.replace(/[:@].*$/, '');

/** `+9647…` from a phone address; null for a LID or anything else. */
export function numberOf(jid: string): string | null {
  const match = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match ? `+${match[1]}` : null;
}

const clean = (value: string) =>
  value
    .replace(/[​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The group's members as people.
 *
 * `users` is the ERP's own contact list (number → user); `names` is what
 * WhatsApp shows for the numbers the owner listed. A participant with no
 * address at all is left out.
 */
export function rosterFrom(
  participants: readonly Participant[],
  known: {
    readonly users: ReadonlyMap<string, { readonly displayName: string; readonly email: string }>;
    readonly names: ReadonlyMap<string, string>;
  },
): Member[] {
  const members: Member[] = [];
  for (const one of participants) {
    const jids = [...new Set([one.id, one.lid, one.phoneNumber, one.jid].filter((value): value is string => typeof value === 'string' && value.includes('@')).map((value) => value.replace(/:\d+@/, '@')))];
    if (jids.length === 0) continue;
    const e164 = jids.map(numberOf).find((value): value is string => Boolean(value)) ?? null;
    const user = e164 ? (known.users.get(e164) ?? null) : null;
    const shown = typeof one.notify === 'string' ? one.notify : typeof one.name === 'string' ? one.name : '';
    const name = clean(user?.displayName ?? (e164 ? known.names.get(e164) : undefined) ?? shown) || e164 || userPart(jids[0]!);
    members.push({ e164, jids, tag: typeof one.id === 'string' && one.id.includes('@') ? one.id.replace(/:\d+@/, '@') : jids[0]!, name, user });
  }
  // Two people with one name are told apart by the end of their number, so a tag can only mean one of them.
  const count = new Map<string, number>();
  for (const member of members) count.set(member.name.toLowerCase(), (count.get(member.name.toLowerCase()) ?? 0) + 1);
  return members.map((member) =>
    (count.get(member.name.toLowerCase()) ?? 0) > 1 && member.e164 && member.name !== member.e164 ? { ...member, name: `${member.name} ${member.e164.slice(-4)}` } : member,
  );
}

function memberByDigits(roster: readonly Member[], digits: string): Member | null {
  return roster.find((member) => member.jids.some((jid) => userPart(jid) === digits)) ?? null;
}

/**
 * A message as it arrived, with its tags turned into names.
 *
 * "@159386907476204" → "@Ali". Only digits that are a member of the group are
 * touched; `mentioned` is who was tagged, in order, each once.
 */
export function readTags(text: string, roster: readonly Member[]): { readonly text: string; readonly mentioned: readonly Member[] } {
  const mentioned: Member[] = [];
  const out = text.replace(/@(\d{6,20})/g, (whole, digits: string) => {
    const member = memberByDigits(roster, digits);
    if (!member) return whole;
    if (!mentioned.includes(member)) mentioned.push(member);
    return `@${member.name}`;
  });
  return { text: out, mentioned };
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An answer as it will be sent, with its names turned into real tags.
 *
 * "@Ali" → "@159386907476204" in the text, and that member's address in
 * `mentions` — the pair WhatsApp needs to draw the name and to notify the
 * person. A full name is matched before a first name; a first name is taken
 * only when one member has it. Digits he copied from an earlier message are
 * kept and given their address too. An `@` that names nobody in the group is
 * left exactly as written.
 */
export function writeTags(text: string, roster: readonly Member[]): { readonly text: string; readonly mentions: readonly string[] } {
  const mentions: string[] = [];
  const tagFor = (member: Member) => {
    if (!mentions.includes(member.tag)) mentions.push(member.tag);
    return `@${userPart(member.tag)}`;
  };
  // Held aside while names are matched, so one tag is never rewritten twice.
  const held: string[] = [];
  const hold = (tag: string) => `\u0000${held.push(tag) - 1}\u0000`;

  let out = text.replace(/@(\d{6,20})/g, (whole, digits: string) => {
    const member = memberByDigits(roster, digits);
    return member ? hold(tagFor(member)) : whole;
  });

  const named = roster.filter((member) => member.name && member.name !== member.e164).sort((a, b) => b.name.length - a.name.length);
  // After a name: the end, or anything that is not a letter or a digit (in any script).
  const after = '(?=$|[^\\p{L}\\p{N}_])';
  for (const member of named) {
    out = out.replace(new RegExp(`@${escape(member.name)}${after}`, 'giu'), () => hold(tagFor(member)));
  }
  const firstNames = new Map<string, Member[]>();
  for (const member of named) {
    const first = member.name.split(' ')[0]!.toLowerCase();
    firstNames.set(first, [...(firstNames.get(first) ?? []), member]);
  }
  for (const [first, who] of firstNames) {
    if (who.length !== 1 || first.length < 2) continue;
    out = out.replace(new RegExp(`@${escape(first)}${after}`, 'giu'), () => hold(tagFor(who[0]!)));
  }
  return { text: out.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => held[Number(index)] ?? ''), mentions };
}

/** The tag that means the whole group, as a person would type it. */
export const EVERYONE_TAG = '@all';

const EVERYONE_LINE = /^[ \t]*@all[ \t]*$/imu;

/**
 * A notice for the whole team (2026-10-13, by direction: "the tagging should
 * be @all, not specific names"): `@all` stays in the text as written, and
 * every member's address goes beside it — which is what makes WhatsApp notify
 * each of them, linked to an ERP user or not. Null when the text has no line
 * that is `@all` and nothing else.
 *
 * A line of its own, because that is where the team's message puts its tags
 * and a notice's own words never are: a subject that happens to say "@all" is
 * in the middle of its bullet, and tags nobody.
 *
 * Only the ERP's own team message is sent this way (the bridge asks this
 * inside an alert and nowhere else). `writeTags` never does it: what the model
 * writes cannot tag a whole group by saying so.
 */
export function tagEveryone(text: string, roster: readonly Member[]): { readonly text: string; readonly mentions: readonly string[] } | null {
  if (!EVERYONE_LINE.test(text)) return null;
  return { text, mentions: [...new Set(roster.map((member) => member.tag).filter((tag) => tag.length > 0))] };
}

/**
 * The members, for the instructions: who is here, who each is in the ERP, and
 * how to tag them.
 */
export function rosterForPrompt(roster: readonly Member[], asker: { readonly e164?: string | null }): string {
  if (roster.length === 0) return '';
  const lines = roster.map((member) => {
    const who = member.user ? `ERP user ${member.user.displayName} <${member.user.email}>` : 'not linked to an ERP user yet';
    const me = asker.e164 && member.e164 === asker.e164 ? ' — THE PERSON ASKING' : '';
    return `• @${member.name} — ${who}${member.e164 && member.name !== member.e164 ? ` · ${member.e164}` : ''}${me}`;
  });
  return [
    `THE PEOPLE IN THIS GROUP (${roster.length}). To tag somebody, write @ and their name exactly as it is written here — it becomes a real WhatsApp tag that notifies them. Tag a person only when the answer is FOR them or needs them to act; never tag everybody.`,
    ...lines,
    'When a message says "for @Name" or "explain to @Name", write the answer to that person: tag them once at the start, in the language they were asked for. The books are still read as the person who ASKED — you never act as the person tagged. Somebody not linked to an ERP user cannot ask you anything themselves until an administrator links their number (Settings → Administration → WhatsApp).',
  ].join('\n');
}
