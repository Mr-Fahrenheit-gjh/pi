// Public capability gate, evaluated at event time (not extension load time).
// notesoup's private enabled/reset flags are intentionally not inspected. Its
// tools stay registered when toggled off, and old resets may still own compaction.
// Yield conservatively for the entire loaded lifetime; removal + reload restores
// native compaction. Active-tool filtering is not evidence of ownership.
export function hasNotesoupContextOwner(pi) {
  const names = new Set(pi.getAllTools().map(tool => tool.name));
  return names.has('empty_brain') && names.has('get_context_remaining');
}
