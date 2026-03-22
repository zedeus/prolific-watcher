/**
 * Toggle the priority filter enabled checkbox.
 */
export async function togglePriorityFilter(enable = true) {
  await (await $('button[data-tab="settings"]')).click();
  await browser.pause(300);
  const checkbox = await $('#priorityFilterEnabledToggle');
  const isChecked = await checkbox.isSelected();
  if (enable && !isChecked) await checkbox.click();
  else if (!enable && isChecked) await checkbox.click();
  await browser.pause(500);
}

/**
 * Fill priority filter fields. Switches to settings tab first.
 */
export async function setPriorityFilter({
  minReward,
  minHourly,
  maxEta,
  minPlaces,
} = {}) {
  await (await $('button[data-tab="settings"]')).click();
  await browser.pause(300);
  if (minReward !== undefined) {
    await (await $('#priorityMinRewardInput')).setValue(String(minReward));
  }
  if (minHourly !== undefined) {
    await (await $('#priorityMinHourlyInput')).setValue(String(minHourly));
  }
  if (maxEta !== undefined) {
    await (await $('#priorityMaxEtaInput')).setValue(String(maxEta));
  }
  if (minPlaces !== undefined) {
    await (await $('#priorityMinPlacesInput')).setValue(String(minPlaces));
  }
}
