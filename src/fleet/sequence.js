// A rolling action takes a fresh look at each member and checks cancellation only between members.
// Once a member starts its stop or start step, that step finishes before cancellation is observed.
export async function runMemberSequence({ members, signal, progress, action, current, skip, perform, message }) {
  const done = [];
  const skipped = [];
  for (let index = 0; index < members.length; index++) {
    if (signal.aborted) throw signal.reason;
    const member = await current(members[index]);
    if (!member) {
      skipped.push(members[index].id);
      continue;
    }
    if (await skip(member)) {
      skipped.push(member.id);
      continue;
    }
    progress(index / members.length, message(action, member, index + 1, members.length));
    try {
      const result = await perform(member);
      if (result === false) skipped.push(member.id);
      else done.push(member.id);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    if (signal.aborted) throw signal.reason;
  }
  return { done, skipped };
}
