# Beacon Finder — Simplified MVP Specification (Android/Chrome)
**Version:** 3.1-Alpha
**Status:** Finalized for Development
**Environment:** Android / Chrome / Landscape-Only

---

## 1. Overview
**Beacon Finder** is a specialized web tool for Android/Chrome. The user selects a target, holds the phone in landscape orientation, and "captures" the view to see a precisely mapped waypoint (red dot) indicating the target's location.

**Hardware Assumption:**
- **OS:** Android (Chrome Browser).
- **Orientation:** Fixed Landscape (90° clockwise rotation).
- **Camera:** Standard Wide-Angle lens.

---

## 2. User Flow
1. **Target Selection:** User inputs a name (e.g., "Eiffel Tower" or "Mount Whitney").
    - System resolves coordinates ($lat_t, lon_t$) and altitude ($h_t$) via Google Places and Elevation APIs.
2. **Viewfinder:** System opens the camera and requests `deviceorientationabsolute` and `geolocation`.
    - Live directional arrows guide the user to the target's bearing.
3. **Capture:** User taps the shutter button.
    - A static frame is captured from the `<video>` stream.
    - Sensor data (User $lat_u, lon_u, h_u$, Heading $ lpha$, Pitch $ eta$) is sampled at the exact moment of capture.
4. **Processing:** The system applies magnetic declination and maps the target coordinates to screen pixels.
5. **Display:** The captured image is shown with the waypoint and a distance label.
6. **Nudge:** User can use Heading and Pitch sliders to fine-tune the dot's position manually.

---

## 3. Data Acquisition (Android/Chrome Sensors)

| Field | Source | Required Logic |
| :--- | :--- | :--- |
| **User Lat/Lon** | `Geolocation API` | High Accuracy: **ON** |
| **User Alt ($h_u$)** | `Geolocation API` | Fallback: Terrain DEM + 1.5m (Eye Level) |
| **True Heading ($ lpha$)** | `deviceorientationabsolute` | Add local Magnetic Declination |
| **Pitch ($ eta$)** | `DeviceOrientation.beta` | Measured in Landscape (90° offset) |
| **H-FOV** | Hardcoded | **70°** (Standard Android Wide Lens) |

### 3.1 Magnetic Declination
Because the Android compass reports Magnetic North, the app uses the `geomagnetism` library to calculate the offset for the user's current GPS location.
$$True\ Heading = Magnetic\ Heading + Declination$$

---

## 4. Target Resolution (Infrastructure)

### 4.1 Geocoding & Elevation
- **Geocoding:** Resolves text to coordinates. If results are ambiguous, the first result is selected.
- **Elevation API:** Fetches $h_t$ (meters Above Sea Level). If the request fails, $h_t$ defaults to 0.
- **Caching:** Target coordinates and elevations are cached in `sessionStorage` to prevent redundant API hits during a single session.

---

## 5. Geospatial Computation (Flat-Plane Model)

To maintain MVP simplicity, this version assumes a linear line-of-sight and does not account for Earth's curvature or atmospheric refraction.

### 5.1 Bearing and Distance
Uses the **Haversine Formula** for computational efficiency:
- **$d$**: Great-circle distance between user and target.
- **$	heta_{target}$**: True North bearing to target.
- **$\Delta	heta = 	heta_{target} -  lpha$**: Relative horizontal offset from the current heading.

### 5.2 Elevation Angle ($\phi$)
Calculated using a standard right-triangle (Euclidean) approach:
1. **Vertical Delta:** $\Delta h = h_t - h_u$
2. **Angle of Elevation:** $\phi =  rctan(\Delta h / d)$

---

## 6. Pixel Mapping (Landscape Logic)

Since the phone is held in a fixed **90° Landscape** orientation, the mapping assumes the X-axis is the long side of the phone. Roll compensation is not included.

### 6.1 Coordinates
- **$PPD_H$ (Pixels Per Degree):** $Width / 70^\circ$
- **$PPD_V$:** Derived from the camera's aspect ratio.
- **$X' = rac{W}{2} + (\Delta	heta 	imes PPD_H)$**
- **$Y' = rac{H}{2} - (\phi 	imes PPD_V)$**

---

## 7. Visibility Gates & UI

### 7.1 Gates
1. **Horizontal:** If the target is outside the FOV, show `[ ← ]` or `[ → ]` indicators.
2. **Vertical:** If the target is too high or too low, show `[ ↑ ]` or `[ ↓ ]` indicators.
3. **Distance Limit:** Hard limit at **70,000m (70km)**. Targets beyond this range will trigger an "Out of Range" notification.

### 7.2 Post-Capture Sliders
- **Heading Nudge:** $\pm 10^\circ$ slider.
- **Pitch Nudge:** $\pm 10^\circ$ slider.
*These sliders update $X'$ and $Y'$ in real-time on the static result screen to compensate for sensor drift.*

---

## 8. Known Limitations & Out of Scope
- **No PNG Export:** User must take a system screenshot to save the result.
- **No Roll Compensation:** User must hold the phone level (parallel to the horizon).
- **Occlusion:** The dot will appear even if the target is behind a building or terrain.
- **Lens Distortion:** Accuracy degrades within 10% of the screen edges.
- **Curvature/Refraction:** Accuracy decreases slightly as the distance approaches the 70km limit.

---

## 9. Open Issues
- **Chrome Sensor Permissions:** Ensure "Generic Sensor API" or "Device Orientation" is toggled in `chrome://flags` if necessary for specific Android builds.
- **API Costs:** Monitor Google Maps Platform usage for Geocoding and Elevation requests.