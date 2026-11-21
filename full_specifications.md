# Beacon Finder — Complete MVP Specification (Live-Only)
**Version:** 2.0-Live
**Status:** Finalized for Development 
**Last Updated:** 2026-03-31

---

## Table of Contents

1. [Overview](#1-overview)
2. [User Flow](#2-user-flow)
3. [Data Acquisition](#3-data-acquisition)
4. [Target Resolution](#4-target-resolution)
5. [Calibration Layer](#5-calibration-layer)
6. [Geospatial Computation](#6-geospatial-computation)
7. [Visibility Filtering](#7-visibility-filtering)
8. [Pixel Mapping & Render](#8-pixel-mapping--render)
9. [Infrastructure & API Requirements](#9-infrastructure--api-requirements)
10. [Known Limitations](#10-known-limitations)
11. [Out of Scope (Post-MVP)](#11-out-of-scope-post-mvp)
12. [Open Issues Summary](#12-open-issues-summary)

---

## 1. Overview

**Beacon Finder** is a web application that allows a user to capture a scene and overlay a visual waypoint (a red dot with label) onto the resulting image, indicating the precise direction of a named target — even when that target is not directly visible (occluded by buildings, terrain, or distance). 

The core pipeline is:

> **Named Target + Live Capture + Sensor Data → Geospatial Computation → Pixel Overlay**

The system operates exclusively on **Live Mode**: User captures directly in-browser via the camera API. Orientation and GPS are sampled at the moment of capture from device sensors to ensure maximum metadata synchronization.

---

## 2. User Flow

The following numbered flow defines the canonical user journey and serves as the integration contract between all system components. The current implementation is a three-step page: target, access, live.

1. **User opens the app (landscape).**
2. **User types a target name (e.g. "Colosseum, Rome") and picks a match.**
      → §4: Geocoding API resolves name → (lat_t, lon_t)
      → If ambiguous results: disambiguation list shown.
      → If resolution fails: error surfaced, user prompted to retry.

3. **User grants camera, location and motion access.**
      → MediaDevices API opens the camera feed.
      → Geolocation API watches the user position continuously.
      → DeviceOrientation API streams heading and pitch.

4. **Live overlay runs every frame.**
      → Video frame is drawn to a canvas.
      → Heading, pitch and saved calibration give the current aim (§5).
      → Geospatial computation (§6) and visibility gates (§7) run on the latest sample.
      → Red dot + label is drawn on screen; off-screen targets are pinned to the edge with turn/tilt hints.

5. **User calibrates on a visible target (optional).**
      → User taps the target building on the live frame; the heading and pitch correction is saved per device (§5.3).

Capture-to-photo (shutter, static result, PNG export) is not part of the current design.

---

## 3. Data Acquisition

### 3.1 Required Metadata Fields

The following fields must be synthesized before computation proceeds. Each field has a primary source and a fallback.

| Field | Purpose | Primary Source | Fallback |
|:------|:--------|:--------------|:---------|
| **GPS Lat/Lon** | User position at capture | `Geolocation API` | Manual map picker |
| **GPS Altitude** ($h_u$) | User elevation ASL (m) | `Geolocation API` | DEM API lookup at user coords |
| **True Heading** | Camera azimuth, North-aligned | `DeviceOrientation.alpha` + declination | Manual heading slider |
| **Pitch** | Vertical camera tilt | `DeviceOrientation.beta` | Manual pitch slider |
| **Roll** ($\gamma$) | Lateral camera rotation | `DeviceOrientation.gamma` | Assume 0° |
| **H-FOV** | Derive $FOV_H$ | `videoTrack.getCapabilities()` | Device lookup / Preset |
| **Image Width / Height** ($W \times H$) | Pixel mapping | Canvas Metadata | — (Required) |

### 3.2 Magnetic Declination Correction

Mobile magnetometers report **Magnetic North**, not **True North**. The system must apply a declination correction before any bearing computation.

$$True\ Heading = Magnetic\ Heading + Declination(\phi, \lambda)$$

**Implementation:** Use the `geomagnetism` JavaScript library. The current WMM2025 model is valid through 2030. No network call required.

> ⚠️ Failure to apply this correction produces heading errors of up to **±20°** depending on geographic location. This is not optional for the accuracy required at 150km.

### 3.3 Live Camera Constraints

Live Mode requires HTTPS and user permission.
- **Android:** Uses `deviceorientationabsolute`.
- **iOS:** Requires `DeviceOrientationEvent.requestPermission()` via a user gesture (e.g., clicking "Start Camera").

### 3.4 FOV Derivation

Horizontal Field of View is derived from the live camera stream:
1. **Primary:** `videoTrack.getCapabilities().horizontalFieldOfView`
2. **Fallback:** User-selected preset:

| Preset | $FOV_H$ | Typical Use Case |
|:-------|:--------|:-----------------|
| Standard | 65° | Main camera, standard smartphones |
| Wide (default) | 68° | Main camera, modern flagship phones |
| Ultra-Wide | 110° | Ultra-wide secondary lens |
| Telephoto | 30° | 3× or 5× optical zoom lens |

---

## 4. Target Resolution

### 4.1 Geocoding
**API:** Google Places API or Nominatim. Present disambiguation list if $>1$ result.

### 4.2 Elevation Lookup
**API:** Open-Elevation or Google Elevation API.
If resolution fails, set $h_t = 0$ (sea level) and show warning: *"Target elevation unavailable — vertical accuracy reduced."*

### 4.3 User Elevation Fallback
If GPS altitude deviates by more than **50 m** from the DEM-derived terrain elevation at the user's coordinates, substitute the DEM value for $h_u$.

### 4.4 Caching
| Data Type | TTL | Storage |
|:----------|:----|:--------|
| Geocoding results | 30 days | Server-side (Redis/Edge KV) |
| Elevation results | Permanent | Server-side |

---

## 5. Calibration Layer

### 5.0 Current Implementation
- Heading and pitch come from the smoothed orientation vector (`geo.js` `cameraVector`, `blendVector`).
- Magnetic declination (WMM 2025, bundled) is added to the sensor heading at the user's position.
- Saved per-device calibration is a list of points (up to 12). Each point is made by tapping the visible target; it stores the sensor aim at that moment and the correction that would put the target under the tap. The correction for any view is an inverse-square blend of nearby points. Taps at different spots in the view correct different parts of the view. A tap that disagrees with the current estimate by more than 30° is rejected. The app warns when used more than 50 km from the last calibration location.
- The target picker is a bottom sheet over the live view ("Change target"), so the target can be switched without leaving the camera. Full screen uses the Fullscreen API and is not available on iPhone Safari.
- Landscape only: the overlay pauses with a "rotate" message in portrait.
- Targets beyond 70 km show a limit message instead of a dot (§7 gate 3 uses 70 km; see Open Issues).

### 5.1 Real-Time Override Controls
Always visible in the UI after capture:
| Control | Range | Default |
|:--------|:------|:--------|
| Heading slider | 0° – 360° | From sensor |
| Pitch slider | −90° – +90° | From sensor |
| FOV preset selector | See §3.4 | 68° |

### 5.2 Manual Mode (Full Fallback)
Triggered if **GPS, Heading, or Pitch** permissions are denied. surfaces:
- **Location:** Map picker pin drop.
- **Heading:** Slider with compass rose aid.
- **Pitch:** Slider with horizon aid.

---

## 6. Geospatial Computation

### 6.1 Bearing and Distance
Use **Vincenty's inverse formulae** for geodetic accuracy.
Relative horizontal offset:
$$\Delta\theta = \theta_{target} - \theta_{camera} \pmod{360}$$
Normalize to $[{-180°},\ {+180°}]$.

### 6.2 Elevation Angle

#### 6.2.1 Raw Elevation Angle
$$\phi_{raw} = \arctan\!\left(\frac{h_t - h_u}{d_{chord}}\right)$$
$$d_{chord} = 2R \sin\!\left(\frac{d}{2R}\right)$$
($R = 6,371,000$ m)

#### 6.2.2 Earth Curvature and Atmospheric Refraction
$$\delta\phi_{net} = \frac{d}{2R}(1 - k)$$
($k = 0.13$)

#### 6.2.3 Corrected Elevation Angle
$$\phi_{corr} = \phi_{raw} - \delta\phi_{net}$$

### 6.3 Vertical FOV Derivation
$$FOV_V = 2 \arctan\!\left(\frac{H}{W} \cdot \tan\frac{FOV_H}{2}\right)$$

---

## 7. Visibility Filtering

1. **Gate 1 — Horizontal:** $|\Delta\theta| \leq \frac{FOV_H}{2}$
   *Fail:* Overlay arrows (←/→). Label: *"Target is [X°] to your [left/right]."*
2. **Gate 2 — Vertical:** $|\phi_{corr}| \leq \frac{FOV_V}{2}$
   *Fail:* Overlay arrows (↑/↓). Label: *"Target is [above/below] frame."*
3. **Gate 3 — Distance:** $d \leq 70,000 \text{ m}$
   *Fail:* *"Target beyond the 70 km limit of this model."*
   *Decision:* 70 km (chosen by the owner). The 150 km value from earlier drafts is not used.

---

## 8. Pixel Mapping & Render

### 8.1 Scale Factors
$$PPD_H = \frac{W}{FOV_H} \qquad PPD_V = \frac{H}{FOV_V}$$

### 8.2 Roll-Compensated Final Coordinates
Apply 2D rotation matrix based on sensor roll $\gamma$:
$$X' = \frac{W}{2} + ((\Delta\theta \cdot PPD_H)\cos\gamma - (\phi_{corr} \cdot PPD_V)\sin\gamma)$$
$$Y' = \frac{H}{2} - ((\Delta\theta \cdot PPD_H)\sin\gamma + (\phi_{corr} \cdot PPD_V)\cos\gamma)$$

### 8.3 Rendering Specification
- **Dot:** 20 px diameter, `#FF0000`, 2 px white stroke.
- **Label:** Target name, distance (km, 1 decimal), elevation (m ASL).
- **Edge Warning:** If $X'$ or $Y'$ is within 10% of canvas edge.

---

## 9. Infrastructure & API Requirements

- **Geocoding API:** Places/Nominatim.
- **Elevation API:** Open-Elevation/Google Elevation.
- **Declination:** `geomagnetism` client-side library.
- **Rate Limiting:** 10 "New Target" searches per hour per user.

---

## 10. Known Limitations
- **L1:** No terrain/building occlusion.
- **L2:** Terrain elevation $\neq$ structure height.
- **L3:** No lens distortion correction (Rectilinear approximation only).

---

## 11. Out of Scope (Post-MVP)
- Multiple waypoints.
- Photo Gallery uploads.
- Photo export of the overlay.

---

## 12. Open Issues Summary
- **I1:** Compass jitter/drift management in Live Mode.
- **I2:** API Cost management for high-volume geocoding.
- **I3:** Safari vs Chrome `DeviceOrientation` implementation differences (iOS heading uses `360 − webkitCompassHeading`; unverified on device).
- **I4:** Declination is applied with the bundled WMM 2025 model (`vendor/declination.js`). Assumes the browser's sensor heading is magnetic north; not yet verified per device. Calibration offsets are for phone bias only, and the app warns beyond 50 km.
- **I5:** Roll is not compensated; the phone must be held level.