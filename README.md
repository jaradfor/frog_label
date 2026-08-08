## Welcome to the Froglabel-studio repository!

This README file will guide you through the important aspects of our project and make navigation through the development files easier.

##### TEAM :

- Cailey Murad
- Erik Duarte
- Anupama Nambiar

---

## ABSTRACT

This project is an easy to use front-end design for an already existing open source data annotation tool called [Label-Studio](https://labelstud.io/). Our project makes it easy to label audio data through the implementation of keyboard shortcuts and tools to modify the display and annotation settings on the webpage. The front-end accesses the converted audio file from Label-Studio and converts it into a spectrogram. The spectrogram further allows the annotator to precisely identify the location of certain audio frequencies which can futher be used to absorb important information and run analysis on the required data. Once the annotator is done annotating, the data is sent back to label-studio and saved on the website as usual within the project on Label-Studio.

## ACCESSING THE FILES

Our project has multiple folders to ease the modification process for future developers. In this repository all of our design files are in the [src](https://github.com/caileymm/froglabel-studio/tree/main/src) folder. This folder holds the components in the [components](https://github.com/caileymm/froglabel-studio/tree/main/src/components) folder that are responsible for the waveform, spectrogram and bounding boxes display. It also holds the files for the tools that a user uses to modify the display of the waveform/annotation descriptions on the screen.

Additionally, we also have the [adapters](https://github.com/caileymm/froglabel-studio/tree/main/src/adapters) folder that allows our front-end to be connected to label-studio backend. This allows for our frontend to communiate with label-studio and annotate projects that a user stores on there.

<details>
  <summary> <b>Click here to see complete GITHUB Structure </b></summary>

```bash
        froglabel-studio/
        ├── .gitignore
        ├── README.md
        ├── eslint.config.js
        ├── index.html
        ├── package-lock.json
        ├── package.json
        ├── public/
        │   ├── favicon.svg
        │   └── icons.svg
        ├── src/
        │   ├── App.css
        │   ├── App.jsx
        │   ├── adapters/
        │   │   ├── demoAdapter.js
        │   │   └── labelStudioCeApiAdapter.js
        │   ├── api/
        │   │   ├── Label-Studio-connection_test.py
        │   │   ├── LabelStudioBackendDevelopment
        │   │   ├── LabelStudioXML.xml
        │   │   └── labelStudio.js
        │   ├── assets/
        │   │   ├── audioFrequencyTestingSounds.mp3
        │   │   ├── crosshair_black.png
        │   │   ├── crosshair_white.png
        │   │   ├── default_black.png
        │   │   ├── default_white.png
        │   │   ├── frog.png
        │   │   ├── frog_id_logo.png
        │   │   ├── green_tree.mp3
        │   │   ├── moon_black.png
        │   │   ├── moon_cursor.png
        │   │   ├── moon_white.png
        │   │   ├── perons_tree.mp3
        │   │   └── red_eyed_tree.mp3
        │   ├── color_palettes/
        │   │   ├── inferno.jsx
        │   │   ├── magma.jsx
        │   │   ├── plasma.jsx
        │   │   └── viridis.jsx
        │   ├── components/
        │   │   ├── BoundingBoxControls.jsx
        │   │   ├── BoundingBoxLayer.jsx
        │   │   ├── BoxFilePanel.jsx
        │   │   ├── CodesPanel.jsx
        │   │   ├── DatasetPanel.jsx
        │   │   ├── Header.jsx
        │   │   ├── LoginScreen.jsx
        │   │   ├── PanelContext.jsx
        │   │   ├── SpectrogramControls.jsx
        │   │   ├── SpectrogramPanel.jsx
        │   │   ├── ThemeButton.jsx
        │   │   ├── Tools.jsx
        │   │   └── WaveformSpectrogram.jsx
        │   ├── context/
        │   │   ├── SessionConfigContext.jsx
        │   │   └── ThemeContext.jsx
        │   ├── domain/
        │   │   └── frogBox.js
        │   ├── hooks/
        │   │   ├── useAnnotationSession.js
        │   │   ├── useSessionConfig.js
        │   │   └── useTheme.js
        │   ├── index.css
        │   ├── main.jsx
        │   ├── serializers/
        │   │   └── labelStudioCeResults.js
        │   └── utils/
        │       ├── audioInfo.js
        │       ├── sessionConfig.js
        │       ├── spectrogramConfig.js
        │       ├── spectrogramScale.js
        │       └── theme.js
        └── vite.config.js
```

</details>

## RUNNING THE PROJECT

### Run locally (for developers):

1. Open Terminal window 1, run:
   ```bash
     cd Desktop
     git clone https://github.com/caileymm/froglabel-studio.git
     pip install label-studio                   #if already installed then skip this step
     echo 'export PATH="$HOME/Library/Python/3.9/bin:$PATH''' >> ~/.zshrc source ~/.zshrc
     label-studio start
   ```
2. Open Terminal window 2, run:
   ```bash
   npm run dev
   ```
3. View local host links
4. Navigate to your Personal Access Token on Label-Studio.
5. Copy the Access Token.
6. Paste the Access Token and task number into the login page on the local web page.

### Demo Mode Access (for developers):

1. Open Terminal window 1, run:

```bash
     cd Desktop
     git clone https://github.com/caileymm/froglabel-studio.git
     npm run dev
```

2. View local host link
3. Switch to DEMO MODE
4. Click Export button to move on to next audio file.

### Run in browser (for non-developers):

1. Navigate to this [LINK](https://caileymm.github.io/froglabel-studio/)

## FEATURES

1.  <b>Audio and Spectrogram visualization</b> - to view and precisely annotate audio signals.
2.  <b>2D Bounding Box annotation over spectrogram</b> - allows for storage of frequency as well as time details of the annotations.
3.  <b>Species code storage and entry to label bounding boxes</b> - 3-letter species codes to map the annotation to the species
4.  <b>Collapsable tool panels</b> - helps edit annotation settings
5.  <b>Easy-to-use left-handed keyboard shortcuts</b> - eases user experience for prolonged period annotations
6.  <b>Dataset Panel</b> - to view live list of all annotated boxes and their details
7.  <b>Connection to self hosted Label studio project</b> - done via API and the next task is fetched automatically
8.  <b>Additional Demo feature<b> - helps test and further develop project without running label studio in the background

## IMPORTANT LINKS

- [FINAL PRESENTATION](https://docs.google.com/presentation/d/1TOCNL7Rg-TOa_IB5ZToZK-hIDA3hgP1P7RpdjB0QWuo/edit?usp=sharing)
- [FINAL VIDEO](https://drive.google.com/file/d/1pu6PP8UIsiFl7K6Xt0NvXc5laxh9SYaq/view?usp=drive_link)
- [INSTRUCTIONS TO USE THE FRONT END](here)
