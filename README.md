# osm-traffic-signs
This project aims to implement the rendering of traffic signs on a leaflet map for visualization, in the data folder there are the JSON definitions for all the various association of tags to SVG which is subdivided in fiels by the country of origin, as the first signs we will try Italian ones to make it good.
The italian guidelines can be found at https://wiki.openstreetmap.org/wiki/IT:Road_signs_in_Italy.
The tags are reppresented in the following way: traffic_sign=IT:'ID Figura'[valore] and the valore part should be changed in the SVGs dynamically,you can find the SVGs on wikimedia.
Keep in mind that this project is supposed to be hosted on github pages.