# Experimental Matter prototype

Status: 28 June 2026

This prototype exposes the Dreo 516S (DR-HAC006S) through the official
Homebridge v2 Matter plugin API while retaining the existing HAP accessory.
Matter is opt-in through `enableMatter: true` and a `matter` block on the same
Dreo child bridge.

## Matter model

| Function | Matter device/cluster | Notes |
| --- | --- | --- |
| Cooling | Room Air Conditioner / OnOff + Thermostat | Off, Cool, target and current temperature |
| Dry | On/Off Plug-in Unit / OnOff | Separately named Apple-supported control |
| Fan Only | On/Off Plug-in Unit / OnOff | Separately named Apple-supported control |
| Manual fan speed | Fan / FanControl | Off, Low, Medium, High; Apple shows 33/66/100 percent |
| Automatic fan speed | On/Off Plug-in Unit / OnOff | Separately named Apple-supported Auto control |
| Current humidity | Humidity Sensor / RelativeHumidityMeasurement | Reports `null` until Dreo supplies a sensor value |
| Swing | On/Off Plug-in Unit / OnOff | Standard binary control |
| Display illumination | On/Off Light / OnOff | Standard light control |
| Sleep | On/Off Plug-in Unit / OnOff | Standard binary control |
| Eco | On/Off Plug-in Unit / OnOff | Standard binary control |

Every row is a separately bridged accessory with its own
`BridgedDeviceBasicInformation.nodeLabel`. This is required for correct names:
iOS 27 ignored both the display name and standard Fixed/User Label clusters on
composed child endpoints and displayed the parent name instead.

The single Dreo `hvacmode` value remains the source of truth, so Cooling, Dry,
and Fan Only are mutually exclusive. Dry and Fan Only are intentionally not
mapped onto Heating or Auto: that would give standard Matter values the wrong
meaning even though Apple Home happens to display those two labels.

The Matter data model currently has no standard writable target-humidity
cluster for a dehumidifier. The HAP `HumidifierDehumidifier` service therefore
continues to provide target humidity; Matter exposes only Dry power and actual
humidity.

Homebridge 2.1.0's command-aware FanControl wrapper drops the Auto feature.
The prototype therefore supplies an Auto-enabled standard `FanDevice` as an
`EndpointType` value accepted by the public Homebridge Matter API. It similarly
supplies a Cooling-only standard `RoomAirConditionerDevice`, preventing
unsupported Heating and Auto features from being advertised while using the
Apple-supported Matter air-conditioner category. The runtime loads
Homebridge's own Matter.js module instance to avoid duplicate behavior
identities. A Cooling-specialized Matter.js thermostat behavior handles
setpoint and mode writes because Homebridge 2.1.0's generic thermostat wrapper
otherwise reintroduces hidden Heating/Auto attributes. Registration, state
publication, caching, and the remaining controls continue through the official
Homebridge v2 Matter plugin API.

## Synchronisation and conflict handling

- HAP and Matter call the same `AirConditionerAccessory` controller.
- Dreo commands are serialized through one promise queue.
- WebSocket reports and 15-second polling update HAP and Matter from the same
  state snapshot.
- Matter behavior handlers suppress feedback during state publication and
  ignore delayed echoes that already match controller state. This prevents a
  published Thermostat Off state from powering down an active Dry/Fan mode.
- The Cooling-only Room Air Conditioner uses a new deterministic accessory
  identity so Homebridge and Apple do not restore the former generic
  Thermostat presentation from cache.
- Resulting complete state is published after commands, including mutually
  dependent endpoints.
- Cooling, Dry, and Fan Only always map to the single Dreo `hvacmode` value and
  are therefore mutually exclusive.

## Automated verification

- Homebridge 2.1.0 and HAP 2.1.7 build and type-check.
- Lint, build, and all 48 automated tests pass.
- Fan speeds 1, 2, 3 and Auto are mapped to Dreo values 1, 2, 3 and 4.
- Apple Home percentage writes 33, 66, and 100 map to Dreo fan levels 1, 2,
  and 3. A separate `Lüfter Auto` switch selects Dreo value 4.
- Off, Cooling, Dry, and Fan Only exclusivity is tested across the thermostat
  and the separate Dry/Fan Only controls.
- Dreo `templevel` is tested as target temperature and `temperature` as measured
  temperature; reports and commands cannot overwrite the other value.
- Dreo WebSocket updates are tested for temperature, humidity, mode, speed,
  Swing, and all dependent Matter endpoints.
- HAP/Matter command overlap is tested to remain serialized.
- Startup snapshots test state restoration after restart/reconnection.
- Published and delayed Matter state echoes are tested not to issue commands
  back to the physical device.
- The definition contains ten separately named bridged accessories and is
  validated by the automated model tests.

## Raspberry Pi verification

Installed prototype:

- Homebridge 2.1.0, HAP 2.1.7, Matter.js 0.17.1
- `homebridge-dreo` 4.5.1
- Dreo child bridge Matter port 5541
- Existing HAP child bridge and pairing retained

Real-device checks:

- Matter mode sequence Dry -> Fan Only -> Cooling -> Off -> Cooling passed;
  every step reported exactly one active mode and no control failures.
- Matter FanControl Low, Medium, and High produced Dreo speeds 1, 2, and 3.
  The separate Fan Auto switch selects Dreo speed 4 and returns to Low when
  switched off.
- Matter Sleep and Eco use the Dreo app WebSocket's native numeric modes 4 and
  5; mode 1 restores normal Cooling. All three transitions were confirmed
  against live device state.
- Target temperature, Swing, Display, Sleep, and Eco: passed.
- HAP Dry propagated to Matter; Matter Cooling propagated back to HAP.
- Simultaneous conflicting HAP/Matter mode commands ended in exactly one active
  mode.
- A Matter target write to 20 C and restore to 22.2 C left measured
  temperature unchanged at 27.2 C. The Dreo target was restored to 72 F.
- Cold boot and subsequent service restarts restored all ten Matter
  accessories, and the Cooling-only thermostat exposes no heating setpoint.
- The running Pi has three expected Homebridge processes and zero swap use
  after the cold boot.
- The final restored state is Cooling, speed 1, Swing and Display on, with
  Sleep and Eco off. Current temperature, target temperature, and humidity are
  republished from the live Dreo state.
- Current humidity is exposed when Dreo reports it and otherwise uses the
  standards-compliant nullable measurement.

## Apple Home observations and pending verification

- The Dreo Matter bridge is paired in Apple Home on iOS 27.
- In the first composed model, Apple Home ignored every child endpoint name and
  displayed the parent name `Eli Matter` on all six switch tiles.
- A second composition using the official Room Air Conditioner parent and both
  Fixed Label and User Label clusters produced the same result: every child
  switch was still named `Eli Klimagerät`.
- Individually bridged names appeared correctly in Apple Home, but as separate
  tiles.
- iOS 27 renders generic Matter Mode Select as `Nicht unterstützt`; the
  experimental `Eli Betriebsart` endpoint was therefore removed.
- iOS 27 rendered even a Cooling-only generic Thermostat with the fixed
  Off/Cooling/Heating/Automatic menu. The final iteration therefore uses the
  separately supported Matter `RoomAirConditioner` device type with OnOff and
  a genuinely Cooling-only Thermostat behavior. It exposes no Heating, Auto,
  Preset, or heating-setpoint attributes.
- The final layout therefore publishes `Eli Trocknen`, `Eli Ventilator`, fan
  speed, Fan Auto, humidity, Swing, Display, Sleep, and Eco as separately
  named bridged accessories.
- iOS 27 renders FanControl primarily as a percentage control even when the
  standard Low/Medium/High/Auto fan modes are present. The plugin cannot force
  Apple Home to render this as a dropdown. The prototype therefore presents
  the three manual levels as 33/66/100 percent and Auto as a separate switch.
- Confirm the restored individual names in Apple Home, then repeat mode,
  fan-speed, restart, and Dreo reconnection checks from Apple Home.

The existing HAP pairing must remain unchanged until these checks have passed.
