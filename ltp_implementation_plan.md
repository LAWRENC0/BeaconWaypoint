# Beacon Finder LTP Implementation Plan

**Source Spec:** `ltp_specifications.md`  
**Target:** First working Local Test Product in browser  
**Architecture:** Pure client-side, no backend  
**Primary Device:** Android phone, Chrome, landscape only

---

## 1. Goal

Build a local test product that proves the core waypoint-overlay workflow:

1. User resolves a named target to coordinates.
2. User opens the camera in browser.
3. User captures a frame.
4. The app freezes the latest sensor data at capture time.
5. The app computes the target's projected screen position.
6. The app draws a red waypoint dot and label on the captured frame.
7. The user manually adjusts horizontal and vertical offsets to evaluate repeatable sensor error.

This first implementation is intended to validate the geometry and sensor model, not to maximize production accuracy.

---

## 2. Scope

### In Scope
- Pure client-side web app
- Camera access through browser
- Geolocation access
- Orientation access
- Target name search via free geocoding API
- Elevation lookup via free API
- Flat-plane projection math
- Static capture result with red dot overlay
- Horizontal and vertical nudge sliders
- Landscape-only UI gate
- Local cache for resolved targets
- Basic error handling and diagnostics

### Out of Scope
- Backend services
- User accounts
- Persistent cloud storage
- Real-time moving overlay
- Roll compensation
- Earth curvature or atmospheric refraction
- Low-end performance optimization

---

## 3. Technical Direction

### Recommended Stack
- HTML
- CSS
- Vanilla JavaScript (ES modules)
- Canvas for captured frame + overlay rendering

### External Dependencies
- Nominatim for target geocoding
- Open-Elevation for altitude lookup
- Local declination library if included in LTP build

### Implementation Principle
Keep projection math isolated in pure functions so it can be tested independently from browser APIs.

---

## 4. Proposed Project Structure

```text
/
  index.html
  styles.css
  src/
    main.js
    state.js
    camera/
      viewfinder.js
      capture.js
    sensors/
      orientation.js
      location.js
    services/
      geocode.js
      elevation.js
      cache.js
    geometry/
      math.js
      projection.js
    ui/
      app-shell.js
      overlay.js
      calibration.js
      debug-panel.js
```

---

## 5. Delivery Phases

## Phase 0: Scaffold

### Objective
Create the app shell and file structure so all later work lands in clean modules.

### Tasks
- Create static app entry point
- Create landscape-only shell layout
- Add sections for:
  - target search
  - camera viewfinder
  - capture button
  - result canvas
  - calibration controls
  - debug panel
- Add baseline CSS for mobile landscape layout

### Acceptance Criteria
- App loads from local server
- Layout renders on desktop and mobile browser
- Portrait mode shows a rotate-to-landscape gate

---

## Phase 1: Permissions, Camera, and Sensors

### Objective
Verify that the browser can provide the required hardware inputs on target device.

### Tasks
- Implement camera start flow using `getUserMedia`
- Render live stream in `<video>`
- Implement geolocation read
- Implement orientation listener
- Store continuously updated "last known" heading and pitch values
- Add UI states for permission denied / unsupported APIs
- Show sensor values in debug panel

### Acceptance Criteria
- User can start camera
- App shows current lat/lon
- App shows current heading and pitch values
- Debug values update while device moves
- App remains functional on Android Chrome

### Risks
- `deviceorientationabsolute` support may vary
- Orientation axis behavior may differ in landscape mode
- Sensor permissions may require explicit user gesture

---

## Phase 2: Target Resolution and Caching

### Objective
Allow the user to search for a target and fetch the data required for projection.

### Tasks
- Add target input form
- Implement Nominatim search
- Add basic result selection or best-match flow
- Implement target caching in `localStorage`
- Fetch target elevation
- Fetch user elevation fallback if GPS altitude is unavailable
- Display resolved target details in UI

### Acceptance Criteria
- User enters a target name and gets a resolved location
- Resolved targets are reused from cache when available
- App displays target name, coordinates, and altitude state

### Risks
- Free API throttling
- Ambiguous geocoding results
- Missing or slow elevation responses

---

## Phase 3: Geometry Engine

### Objective
Implement the LTP projection model in a deterministic, testable form.

### Tasks
- Implement haversine distance
- Implement forward azimuth / bearing
- Implement relative horizontal angle normalization
- Implement elevation angle calculation
- Implement FOV calculations:
  - `H_FOV = 70`
  - `V_FOV = (window.innerHeight / window.innerWidth) * 70`
- Implement pixels-per-degree:
  - `PPD_H = width / H_FOV`
  - `PPD_V = height / V_FOV`
- Implement screen projection:
  - `X = width / 2 + deltaHeading * PPD_H`
  - `Y = height / 2 - elevationAngle * PPD_V`
- Add boundary tests for:
  - zero offset
  - left/right edge
  - above/below frame
  - max distance gate

### Acceptance Criteria
- Geometry functions work independently of UI
- Known sample inputs produce stable `X/Y` outputs
- Relative angle wraparound behaves correctly near north crossing

### Risks
- Degree/radian mix-ups
- Incorrect sign conventions for pitch/elevation
- Landscape orientation assumptions may invert axes on some devices

---

## Phase 4: Capture and Static Overlay

### Objective
Create the full LTP capture flow from live preview to annotated result.

### Tasks
- Capture current video frame into canvas
- Freeze latest sensor sample at capture time
- Compute target projection with current frame dimensions
- Draw red dot on result canvas
- Draw label with target name and distance
- Pause or hide live video after capture
- Add reset / retake flow

### Acceptance Criteria
- User captures a frame
- Result screen displays static image
- Red dot appears at computed location if in frame
- Label shows target name and distance
- User can retake the shot

---

## Phase 5: Calibration Controls

### Objective
Allow manual correction of dot placement to evaluate sensor bias.

### Tasks
- Add horizontal offset slider
- Add vertical offset slider
- Re-render overlay as sliders move
- Display current offset values
- Keep original computed position visible in debug panel

### Acceptance Criteria
- Horizontal slider moves dot by `-100` to `+100` px
- Vertical slider moves dot by `-100` to `+100` px
- Dot updates immediately without recapturing

---

## Phase 6: Safety Gates and Error States

### Objective
Prevent misleading outputs when the capture or target context is invalid.

### Tasks
- Enforce hard distance limit at 70 km
- Show "out of range" state for targets beyond limit
- Detect off-canvas `X/Y`
- Show "target not in frame" message when projected point falls outside image bounds
- Add fetch/network error states
- Add sensor unavailable states

### Acceptance Criteria
- App blocks invalid result states with clear messaging
- Each major failure mode has a visible UI response

---

## Phase 7: Field Validation

### Objective
Use the LTP on a real device to determine whether the model is viable.

### Tasks
- Test with short-distance targets
- Test with medium-distance targets
- Compare raw projection versus nudged projection
- Record repeated bias patterns
- Evaluate whether declination correction is required immediately
- Evaluate whether pitch handling is stable enough for next iteration

### Acceptance Criteria
- Team can capture and review repeatable real-world results
- Bias patterns are documented
- Next iteration priorities are evidence-based

---

## 6. Cross-Cutting Concerns

### Debugging
The app should expose a compact debug panel with:
- user coordinates
- target coordinates
- target altitude
- user altitude
- heading
- pitch
- distance
- bearing
- relative heading
- elevation angle
- computed `X/Y`
- manual offsets

### State Management
Maintain a small central app state:
- permissions
- camera stream
- latest orientation sample
- latest location sample
- resolved target
- capture frame
- computed projection
- slider offsets
- current UI mode

### UI Modes
Recommended states:
- boot
- needs-landscape
- ready
- live-preview
- captured-result
- error

---

## 7. Open Decisions

The following should be resolved during implementation:

1. Should declination correction be included in the first LTP build or added after baseline testing?
2. Should the first capture flow use the latest continuously sampled geolocation or request a fresh reading on capture?
3. How should ambiguous geocoding matches be presented: simple best match or explicit disambiguation list?
4. Should user altitude use GPS directly whenever available, or should DEM comparison be added immediately?
5. Should the dot be rendered even when slightly out of frame, or should the app fail hard once outside bounds?

---

## 8. Recommended Execution Order

1. Scaffold app shell
2. Implement camera and sensor permissions
3. Confirm Android Chrome behavior on device
4. Implement target lookup and cache
5. Implement pure geometry module
6. Build capture-to-canvas flow
7. Draw result overlay
8. Add nudge controls
9. Add safety gates and debug panel
10. Field test on phone

---

## 9. Definition of Done for LTP v1

The LTP v1 is complete when:
- It runs locally in browser with no backend
- It works in landscape mode on Android Chrome
- It resolves a target name to coordinates
- It captures a frame from live camera
- It uses frozen capture-time sensor values
- It computes and renders a waypoint dot and label
- It supports manual `X/Y` nudge sliders
- It handles out-of-range and off-frame cases
- It provides enough diagnostics to judge whether the model is usable

---

## 10. Recommended Next Step

Start implementation with **Phase 0 + Phase 1** only.

Reason:
- These phases validate the hardest browser/hardware assumptions first.
- If camera or orientation behavior is unstable, the geometry work should not be trusted yet.
- Once the sensor layer is proven on-device, the geometry and overlay can be built with much less risk.
