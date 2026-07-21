(function (root, factory) {
  const api = factory(root.RoomWave || {});
  root.RoomWave = Object.assign(root.RoomWave || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis, function () {
  const SCHEMA_VERSION = 1;
  const SPEED_OF_SOUND = 343;
  return { SCHEMA_VERSION, SPEED_OF_SOUND };
});
