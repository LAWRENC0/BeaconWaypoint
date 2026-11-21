> **Superseded.** The photo-capture design in this document is no longer the target. The current direction is the live overlay described in [full_specifications.md](full_specifications.md).

# Beacon Finder ‚Äî Simplified MVP Specification (Android/Chrome)
**Version:** 3.2-Alpha
**Status:** Finalized for Development
**Environment:** Android / Chrome / Landscape-Only

---

## 1. Overview
**Beacon Finder** is a specialized web tool for Android/Chrome. The user selects a target and uses a clean camera viewfinder to capture a photo. Post-capture, the system computes the target's location and overlays a precisely mapped waypoint (red dot) on the static image.

**Hardware Assumption:**
- **OS:** Android (Chrome Browser).
- **Orientation:** Fixed Landscape (90¬∞ clockwise rotation).
- **Camera:** Standard Wide-Angle lens.

---

## 2. User Flow
1. **Target Selection:** User inputs a name. System resolves coordinates ($lat_t, lon_t$) and altitude ($h_t$) via Google APIs.
2. **Viewfinder (Clean):** System opens the camera feed. **No live overlays or directional arrows are shown.**
3. **Capture:** User taps the shutter button.
    - A static frame is captured from the `<video>` stream.
    - Sensor data (User $lat_u, lon_u, h_u$, Heading $ lpha$, Pitch $ eta$) is sampled at the exact moment of capture.
4. **Processing:** The client sends sensor and target data to the server via a **REST POST** request.
5. **Display (Result Screen):** The captured static image is displayed with:
    - A **Red Dot** waypoint at the calculated $(X, Y)$ coordinates.
    - A distance label.
6. **Nudge (Manual Calibration):** User adjusts "Heading" and "Pitch" sliders to manually offset the dot if sensor drift occurred.

---

## 3. Data Acquisition (Android/Chrome Sensors)

| Field | Source | Required Logic |
| :--- | :--- | :--- |
| **User Lat/Lon** | `Geolocation API` | High Accuracy: **ON** |
| **User Alt ($h_u$)** | `Geolocation API` | Fallback: Terrain DEM + 1.5m (Eye Level) |
| **True Heading ($ lpha$)** | `deviceorientationabsolute` | Captured only at moment of shutter tap |
| **Pitch ($ eta$)** | `DeviceOrientation.beta` | Captured only at moment of shutter tap |
| **H-FOV** | Hardcoded | **70¬∞** (Standard Android Wide Lens) |

---

## 4. Communication Architecture

### 4.1 The POST Request
The client sends a single payload to the server after capture:
- **Sensors:** Lat, Lon, Alt, Heading, Pitch.
- **Metadata:** Target ID, Screen Resolution ($W, H$).

### 4.2 The Response
The server returns:
- **Coordinates:** $X, Y$ pixel positions.
- **Metadata:** Distance in kilometers, Target Altitude.

---

## 5. Geospatial Computation (Flat-Plane Model)

To maintain MVP simplicity, the server uses a linear line-of-sight model and ignores Earth's curvature/refraction.

### 5.1 Bearing and Distance
- **$d$**: Great-circle distance (Haversine). **Hard limit: 70km.**
- **$	heta_{target}$**: True North bearing to target.
- **$\Delta	heta = 	heta_{target} -  lpha$**: Relative horizontal offset.

### 5.2 Elevation Angle ($\phi$)
Calculated using Euclidean trigonometry:
1. **Vertical Delta:** $\Delta h = h_t - h_u$
2. **Angle of Elevation:** $\phi =  rctan(\Delta h / d)$

---

## 6. Pixel Mapping & Nudge Logic

### 6.1 Initial Mapping (Server Side)
- **$X_{base} =  rac{W}{2} + (\Delta	heta 	imes  rac{W}{70^\circ})$**
- **$Y_{base} =  rac{H}{2} - (\phi 	imes PPD_V)$**

### 6.2 Nudge Sliders (Client Side)
To compensate for magnetic interference or tilt errors, the user can adjust the dot position locally:
- **Heading Slider:** Adds $\pm 10^\circ$ offset to $\Delta	heta$.
- **Pitch Slider:** Adds $\pm 10^\circ$ offset to $\phi$.
- **Logic:** $X_{final} = X_{base} + (Offset_{heading} 	imes PPD_H)$.

---

## 7. UI Constraints & Gates
1. **Distance Gate:** Targets > 70km return an "Out of Range" error.
2. **Visibility Gate:** If the calculated $X, Y$ fall outside the image boundaries, the system displays a "Target not in photo" message.
3. **Static Result:** No animation. The dot is a fixed overlay on the captured JPG/Canvas frame.

---

## 8. Out of Scope
- **Live Tracking:** No real-time movement of the dot.
- **Roll Compensation:** User must keep the phone level with the horizon.
- **Curvature/Refraction:** Excluded for simplicity.