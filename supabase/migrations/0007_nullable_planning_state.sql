-- Additive/relaxing migration — run AFTER 0001 through 0006.
-- shift_start, shift_end, rest_before_shift_hours, and weekly_hours are
-- planning state, not identity — they should be derivable from Weekly
-- Planning/roster generation, not required at employee creation. Making
-- them nullable lets a freshly-created employee genuinely have "no plan
-- yet" instead of a fabricated placeholder shift.

alter table employees alter column shift_start drop not null;
alter table employees alter column shift_end drop not null;
alter table employees alter column rest_before_shift_hours drop not null;
alter table employees alter column weekly_hours drop not null;
