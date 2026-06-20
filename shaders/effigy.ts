/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Effigy" — a raymarched vocalising wraith.
 *
 * Adapted from a Shadertoy multi-pass shader (Buffer A + Image blur pass). A
 * stack of rotating capsules forms a morphing figure, mirrored against itself
 * and a reflective floor, ringed by orbiting motes and a strobing sigil. The
 * Buffer pass writes a per-pixel blur radius into the alpha channel which the
 * Image pass uses for a depth-of-field haze.
 *
 * The scene's distinct parts are broken out into addressable ELEMENTS, each
 * driven by an audio band via two auto-generated uniforms:
 *   <id>_react   -> band value * amount   (reactivity)
 *   <id>_visible -> 1.0 / 0.0             (hide toggle)
 *
 * Elements:
 *   core    -> the morphing capsule figure (drives swell + spin)
 *   spheres -> the orbiting echo motes     (drives their size)
 *   flicker -> the strobing energy sigil   (drives its intensity)
 *   bloom   -> the Image-pass haze blur    (drives blur spread)
 *
 * GLSL ES 1.00 notes vs the original Shadertoy source:
 *   - texture() -> texture2D()
 *   - the Image blur loop now uses constant integer bounds (ES 1.00 forbids
 *     loop limits derived from runtime values).
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

uniform float core_react;
uniform float core_visible;
uniform float spheres_react;
uniform float spheres_visible;
uniform float flicker_react;
uniform float flicker_visible;

float hs(vec3 p){return fract(sin(dot(p,vec3(45.,956.,124.)))*7845.236);}
float rd(vec3 p){return fract(sin(dot(floor(p),vec3(45.,956.,124.)))*7845.236);}
float no (vec3 p){vec3 f = floor(p); p = smoothstep(0.,1.,fract(p));
vec3 se = vec3(45.,95.,457.);vec4 v1 = dot(f,se)+vec4(0.,se.y,se.z,se.y+se.z);
vec4 v2 = mix(fract(sin(v1)*4587.236),fract(sin(v1+se.x)*4587.236),p.x);
vec2 v3 = mix(v2.xz,v2.yw,p.y);
return mix(v3.x,v3.y,p.z);}
float no (vec2 p){vec2 f = floor(p); p = smoothstep(0.,1.,fract(p));
vec2 se = vec2(45.,457.);vec2 v1 = dot(f,se)+vec2(0.,se.y);
vec2 v2 = mix(fract(sin(v1)*4587.236),fract(sin(v1+se.x)*4587.236),p.x);
return mix(v2.x,v2.y,p.y);}
float it (vec2 p){ float r = 0.; float a = 0.5;for(int  i = 0 ; i < 4 ; i++){
r += no(p/a)*a;a*=0.5;}return r;}
float rd (float t){return fract(sin(dot(floor(t),45.))*7845.);}
float no(float t){return mix(rd(t),rd(t+1.),smoothstep(0.,1.,fract(t)));}
mat2 rot(float t) {float c = cos(t); float s = sin(t); return mat2(c,-s,s,c);}
float cap (vec3 u, vec3 a, vec3 b) {vec3 ua= u-a; vec3 ba=b-a;
float h = clamp(dot(ua,ba)/dot(ba,ba),0.,1.);
return length(ua-ba*h);}
float cap (vec2 u, vec2 a, vec2 b) {vec2 ua= u-a; vec2 ba=b-a;
float h = clamp(dot(ua,ba)/dot(ba,ba),0.,1.);
return length(ua-ba*h);}
float smin(float d1,float d2,float k){float h = clamp(0.5+0.5*(d2-d1)/k,0.,1.);
return mix(d2,d1,h)-k*h*(1.-h);}
float smax(float d1,float d2,float k){float h = clamp(0.5-0.5*(d2+d1)/k,0.,1.);
return mix(d2,-d1,h)+k*h*(1.-h);}
float bl (vec2 p, vec2 b){vec2 q = abs(p)-b;
return length(max(vec2(0.),q))+min(0.,max(q.x,q.y));}
float zb = 0.;
float map(vec3 p){
vec3 ps = p;
vec3 pf = p ;
vec3 pt = p;
float l1 = 100.;
vec3 bs = vec3(0.,-3.5,0.);
float ta = mix(1.5,.3,smoothstep(0.,8.,abs(p.y)));
ta *= 1. + core_react*0.6;
float ft = fract(iTime*0.5);
float t = sin(sin(iTime*0.1)*0.1*pow(mix(ft,1.-ft,step(0.5,fract(iTime*0.25))),1.5))*sin(iTime*0.1)*180.;
p.xy *= rot(p.y*sin(iTime)*0.2*(1.+core_react));
p.xz *= rot(p.y*sin(iTime+0.5)*0.2*(1.+core_react));
vec3 p2 = p;
vec3 p3 = p;
float l2 = 1000.;float l3 = 1000.;
p2.xz *= rot(3.14);
for(int i = 0 ; i <5 ; i++){
float ip = float(i);
vec3 v0 = vec3(sin(ip-1.+t),sin(ip-1.+t),cos(ip-1.+t)*0.5)*2.;
vec3 v1 = vec3(sin(ip+t),sin(ip+t),cos(ip +t)*0.5)*2.;
bs +=vec3(0.,1.5,0.);
v0 +=bs-vec3(0.,0.75,0.);
v1 += bs+vec3(0.,0.75,0.);
l1 = min(l1,cap(p,v0,v1)-ta);
l1 = min(l1,cap(p2,v0,v1)-ta*0.5);
l1 = min(l1,cap(p3,v0,v1)-ta*0.25);
l3 = min(l3,length(ps+v0*vec3(2.,1.,2.))-0.3*(1.+spheres_react*1.5));
}
if(core_visible < 0.5) l1 = 1e5;
if(spheres_visible < 0.5) l3 = 1e5;
zb = 1.;
float r1 =  min(l1,l2);
float r2 = r1-hs(p)*0.003;
float r3 = min(r2,l3);
float s = dot(ps,vec3(0.,1.,0.))+4.;

if(r2<min(s,l3)){zb = 0.;}
return min(r3,s);}
float map2 (vec3 p){
float s = dot(p,vec3(0.,1.,0.))+4.;
return s;
}
float map(float value, float min1, float max1, float min2, float max2) {
  return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
}
vec3 nor(vec3 p){ vec2 e =vec2(0.01,0.); return normalize(map(p)-vec3(map(p-e.xyy),map(p-e.yxy),map(p-e.yyx)));}
vec3 ov(vec3 a,vec3 b){ return mix(2.*a*b,1.-2.*(1.-a)*(1.-b),step(0.5,a));}
float ev (vec3 r ,float bl ) {
float ta = mod(iTime,floor(fract(0.1)*10.));
return smoothstep(0.5+bl,0.5,pow(length(r.x-r.z),-smoothstep(0.,1.8,length(r.y-0.2))*0.51+0.8))
* smoothstep(0.5+bl,0.5,pow(length(r.y-0.2),-smoothstep(0.,2.,length(r.x-r.z))*0.51+0.8));
}
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv =-1.+2.*fragCoord/iResolution.xy;
     uv.x *= iResolution.x/iResolution.y;
     float time = iTime;
    vec3 p = vec3(0.,-1.,-7.);
    vec3 r = normalize(vec3(uv,1.));
    r.xz *= rot(sin(time)*0.1);
    r.zy *= rot(cos(time)*0.1);
    vec3 p2 = p;
    vec3 r2 = r;
    float dd = 0.;
    float ref = 1.;
     vec3 n =vec3(0.);
     float mf = zb;
     float mf2 = 0.;float mf3 = 0.;
    const float md = 12.;

    for(int i =0;i<48;i++){
    float d = map(p);
    if(dd>md){dd=md;break;}
    if(d<0.001){

    mf = zb;
    ref *= mf;
    n = nor(p);
    if(ref<0.01){break;}
    mf2 = zb;
    r =reflect(r,n);
    d = 0.01;
    }
    p += r*d;
    dd +=d;
    }

    float dd2 = 0.;
    for(int j = 0 ; j < 7 ; j++){
    float d2 = map2(p2);
    if(d2<0.01){break;}
    p2 += r2*d2;
    dd2 += d2;
    }
    vec2 e = vec2(0.01,0.);
    vec2 pt  = p2.xz*1.5;
    float tex = smoothstep(0.3,0.7, it(pt));
    float tex2 = smoothstep(0.3,0.7, it(pt+e.xy));
    float tex3 = smoothstep(0.3,0.7, it(pt+e.yx));
    vec3 tn = normalize(vec3(tex-tex2,0.2,tex-tex3));
    vec3 n2 = n +tn*mf2;
    float s = smoothstep(md-1.,7.,dd);
    float s2 = smoothstep(md-1.,7.,dd2);
    float s3 = max(s,s2);
    float s4 =  max(smoothstep(md-1.,md-2.,dd),smoothstep(md-1.,md-2.,dd2));
    float ta = smoothstep(0.3,0.7,fract(time*5.));
    float dao = 0.2;
    float ao = max(mix(0.8,1.,clamp(map(p+n2*dao)/dao,0.,1.)),0.);
    float dss = 1.5;
    float ss = clamp(map(p+r*dss)/dss,0.,1.)*(1.-mf);
    float dr = clamp(dot(n2,-r2),0.,1.);
    float fres = pow(1.-dr,0.5);
    float spec = pow(dr,10.);
    float spec2 = pow(dr,100.);
    float r1 = pow(((fres*0.5+spec*0.3+spec2*0.02)*ao+ss*0.2),0.5);
    float vaf = (1.-mf)*(1.-mf2*0.5);
    float vt = step(0.5,fract(time*5.));
    float va2 =ev(r,0.01)*vt*flicker_visible*(1.+flicker_react*2.);
    float va3 = mix(-1.,dot(n,vec3(1.,0.,1.)),vt);
    float sat  = mix(0.,mix(0.2,0.,ao)+mix(0.05,0.2,smoothstep(-4.,5.,p.y+p.z*0.5))+ss*0.1+ss*0.05,vaf)*0.8+(-1.*va3)*0.13;
    float val  = mix(va2*0.5,mix(0.9,0.4,smoothstep(-4.,5.,p.y+p.z*0.5))+mix(-0.15,0.1,va3),vaf)*ao+fres*0.2+(spec2*0.1+spec*0.1)*(1.-mf)+ss*0.2+clamp(va3,0.,1.)*0.5;
    float hue  = clamp(p.y*-0.09*(1.-mf)+0.8+mix(0.1,0.,ao),0.6,1.)+mf*0.3;
    vec3 c1 = mix(vec3(1.),3.*abs(1.-2.*fract(hue+vec3(0.,-1./3.,1./3.)))-1.,sat)*val;
    vec3 c2 = mix(vec3(va2),c1,s3);
    c2 = clamp(c2,0.,1.);
   float hl = pow((c2.x+c2.y+c2.z)/3.,10.);
    float m = mf2*mix(0.0001,0.0009,1.-tex)*mix(0.,1.,length(uv.y))*8.+(pow(length(uv.y),2.)*0.002+0.0001)*(1080./iResolution.y);

    fragColor = vec4(c2,m);
}
void main(){ vec4 c; mainImage(c, vUv*iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float bloom_react;
uniform float bloom_visible;
void mainImage( out vec4 fragColor, in vec2 fragCoord ){
vec2 uv = fragCoord/iResolution.xy;
float m = texture2D(iChannel0,uv).a;
vec3 c = vec3(0.);
float d = m*(1.+bloom_react*2.);
if(bloom_visible < 0.5){
  fragColor = vec4(texture2D(iChannel0,uv).xyz,1.);
  return;
}
for(int i = -4; i<=4 ;i++)
for(int j = -4; j<=4 ;j++){
c += texture2D(iChannel0,uv+vec2(float(i),float(j))*d).xyz;
}
c /=81.;
c = clamp(c,0.,1.);
fragColor =vec4(c,1.);}
void main(){ vec4 c; mainImage(c, vUv*iResolution.xy); gl_FragColor = c; }
`;

export const effigy: ShaderDef = {
  id: 'effigy',
  name: 'Effigy',
  description:
    'Raymarched vocalising wraith — a morphing capsule figure mirrored over a reflective floor, ringed by orbiting motes.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'core',
      name: 'Effigy',
      description: 'The morphing capsule figure. React drives its swell + spin.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'spheres',
      name: 'Echo Motes',
      description: 'Orbiting spheres tracing the figure. React drives their size.',
      defaultBand: 'high',
      defaultAmount: 1.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'flicker',
      name: 'Sigil Strobe',
      description: 'The strobing cross of energy in the void. React drives its intensity.',
      defaultBand: 'low',
      defaultAmount: 1.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Haze',
      description: 'Post-process depth-of-field blur. React drives the blur spread.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
