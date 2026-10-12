/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Cornell Screens" — a progressive-free path-traced Cornell box (NEE + MIS)
 * whose two boxes are video screens.
 *
 * Adapted from a Shadertoy path tracer (GLSL ES 3.00). Every face of the tall
 * box shows the video on iChannel1, every face of the small cube shows the
 * video on iChannel2. The video is both the surface albedo (so it bounces
 * coloured light into the room) and a soft emitter (so it reads as a screen).
 *
 * Elements:
 *   light   -> the orbiting area light (drives intensity)
 *   tower   -> the tall box / iChannel1 screen (drives spin)
 *   cube    -> the small box / iChannel2 screen (drives hop)
 *   screens -> the video surfaces on both boxes (drives screen glow)
 *   walls   -> the room walls (drives hue shift of the coloured walls)
 */

const bufferShader = `
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 outColor;

uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel1;
uniform sampler2D iChannel2;
uniform vec3 iChannelResolution[4];

uniform float light_react;
uniform float light_visible;
uniform float tower_react;
uniform float tower_visible;
uniform float cube_react;
uniform float cube_visible;
uniform float screens_react;
uniform float screens_visible;
uniform float walls_react;
uniform float walls_visible;

#define INFINITY 9999999.0
#define PI 3.141592653589
#define NUM_SAMPLES 32
#define NUM_BOUNCES 3

float light_size;
float light_area;
vec3 light_position;
vec3 light_normal;
int seed;
vec4 light_albedo;
int flat_idx;
bool light_on;

vec2
sample_disk(vec2 uv)
{
	float theta = 2.0 * 3.141592653589 * uv.x;
	float r = sqrt(uv.y);
	return vec2(cos(theta), sin(theta)) * r;
}

vec3
sample_cos_hemisphere(vec2 uv)
{
	vec2 disk = sample_disk(uv);
	return vec3(disk.x, sqrt(max(0.0, 1.0 - dot(disk, disk))), disk.y);
}

mat3
construct_ONB_frisvad(vec3 normal)
{
	mat3 ret;
	ret[1] = normal;
	if(normal.z < -0.999805696) {
		ret[0] = vec3(0.0, -1.0, 0.0);
		ret[2] = vec3(-1.0, 0.0, 0.0);
	}
	else {
		float a = 1.0 / (1.0 + normal.z);
		float b = -normal.x * normal.y * a;
		ret[0] = vec3(1.0 - normal.x * normal.x * a, b, -normal.x);
		ret[2] = vec3(b, 1.0 - normal.y * normal.y * a, -normal.y);
	}
	return ret;
}

void
encrypt_tea(inout uvec2 arg)
{
	uvec4 key = uvec4(0xa341316c, 0xc8013ea4, 0xad90777d, 0x7e95761e);
	uint v0 = arg[0], v1 = arg[1];
	uint sum = 0u;
	uint delta = 0x9e3779b9u;

	for(int i = 0; i < 32; i++) {
		sum += delta;
		v0 += ((v1 << 4) + key[0]) ^ (v1 + sum) ^ ((v1 >> 5) + key[1]);
		v1 += ((v0 << 4) + key[2]) ^ (v0 + sum) ^ ((v0 >> 5) + key[3]);
	}
	arg[0] = v0;
	arg[1] = v1;
}

vec2
get_random()
{
	uvec2 arg = uvec2(flat_idx, seed++);
	encrypt_tea(arg);
	return fract(vec2(arg) / vec2(0xffffffffu));
}

struct Ray
{
	vec3 origin, dir;
};

struct AABB
{
	vec3 min_, max_;
};

mat4
rotate_y(float a)
{
	mat4 ret = mat4(1.0);
	ret[0][0] = ret[2][2] = cos(a);
	ret[0][2] = sin(a);
	ret[2][0] = -ret[0][2];
	return ret;
}

vec3
hue_rotate(vec3 c, float a)
{
	const vec3 k = vec3(0.57735);
	float ca = cos(a);
	return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

vec3
sample_light(vec2 rng)
{
	return light_position + vec3(rng.x - 0.5, 0, rng.y - 0.5) * light_size;
}

bool
intersect_aabb(in Ray ray, in AABB aabb, inout float t_min, inout float t_max)
{
	vec3 div = 1.0 / ray.dir;
	vec3 t_1 = (aabb.min_ - ray.origin) * div;
	vec3 t_2 = (aabb.max_ - ray.origin) * div;

	vec3 t_min2 = min(t_1, t_2);
	vec3 t_max2 = max(t_1, t_2);

	t_min = max(max(t_min2.x, t_min2.y), max(t_min2.z, t_min));
	t_max = min(min(t_max2.x, t_max2.y), min(t_max2.z, t_max));

	return t_min < t_max;
}

vec3
ray_at(in Ray ray, float t)
{
	return ray.origin + t * ray.dir;
}

float
intersect_plane(
	Ray ray,
	vec3 center,
	vec3 normal)
{
	float denom = dot(ray.dir, normal);
	float t = dot(center - ray.origin, normal) / denom;
	return t > 0.0 ? t : INFINITY;
}

float
intersect_box(Ray ray, out vec3 normal, vec3 size)
{
	float t_min = 0.0;
	float t_max = 999999999.0;
	if(intersect_aabb(ray, AABB(-size, size), t_min, t_max)) {
		vec3 p = ray_at(ray, t_min);
		p /= size;
		if(abs(p.x) > abs(p.y)) {
			if(abs(p.x) > abs(p.z)) {
				normal = vec3(p.x > 0.0 ? 1.0 : -1.0, 0, 0);
			}
			else {
				normal = vec3(0, 0, p.z > 0.0 ? 1.0 : -1.0);
			}
		}
		else if(abs(p.y) > abs(p.z)) {
			normal = vec3(0, p.y > 0.0 ? 1.0 : -1.0, 0);
		}
		else {
			normal = vec3(0, 0, p.z > 0.0 ? 1.0 : -1.0);
		}

		return t_min;
	}

	return INFINITY;
}

/*
 * Map a box-local hit point to [0,1] video coords on the face it lies on,
 * upright and unmirrored as seen from outside the box, cropped to cover the
 * face without stretching the video.
 */
vec2
box_face_uv(vec3 lp, vec3 n, vec3 size, vec3 res)
{
	vec2 uv, dim;
	if(abs(n.x) > 0.5) {
		uv = vec2(-n.x * lp.z, lp.y);
		dim = size.zy;
	}
	else if(abs(n.y) > 0.5) {
		uv = vec2(lp.x, -n.y * lp.z);
		dim = size.xz;
	}
	else {
		uv = vec2(n.z * lp.x, lp.y);
		dim = size.xy;
	}
	uv /= dim;

	float face_aspect = dim.x / dim.y;
	float video_aspect = res.x / res.y;
	if(video_aspect > face_aspect)
		uv.x *= face_aspect / video_aspect;
	else
		uv.y *= video_aspect / face_aspect;

	return uv * 0.5 + 0.5;
}

/* Albedo + emission of a video-screen box face (linear colour). */
void
shade_screen(sampler2D tex, vec3 res, vec3 lp, vec3 n, vec3 size,
		out vec4 albedo, out vec3 emission)
{
	albedo = vec4(0.7, 0.7, 0.7, 0);
	emission = vec3(0);
	if(screens_visible < 0.5 || res.x <= 0.0)
		return;

	vec3 c = textureLod(tex, box_face_uv(lp, n, size, res), 0.0).rgb;
	c = pow(c, vec3(2.2));
	albedo = vec4(c * 0.85, 0);
	emission = c * (0.35 + screens_react * 1.5);
}

float
intersect_light(Ray ray)
{
	float t = intersect_plane(ray, light_position, light_normal);

	vec3 p = ray_at(ray, t);
	if(all(lessThan(abs(light_position - p).xz, vec2(light_size * 0.5)))) {
		return t;
	}

	return INFINITY;
}

/*
 * When \`shade\` is false (shadow rays) only the distance is needed, so the
 * video lookups are skipped.
 */
float
intersect(Ray ray, bool shade, inout vec3 p, inout vec3 normal, out vec4 albedo,
		out vec3 emission)
{
	float t_min = INFINITY;

	albedo = vec4(0.0);
	emission = vec3(0.0);

	if(light_on) {
		float t = intersect_light(ray);
		if(t < t_min) {
			albedo = light_albedo;
			normal = light_normal;
			t_min  = t;
			p = ray_at(ray, t);
		}
	}

	/* tall box -> iChannel1 */
	if(tower_visible > 0.5) {
		vec3 normal_tmp;
		vec3 size = vec3(0.25, 0.5, 0.25);
		Ray ray_tmp = ray;
		mat4 r = rotate_y(0.3 + tower_react * 0.8);
		ray_tmp.origin -= vec3(-0.35, -0.5, -0.35);
		ray_tmp.dir = vec3(r * vec4(ray_tmp.dir, 0));
		ray_tmp.origin = vec3(r * vec4(ray_tmp.origin, 1.0));
		float t = intersect_box(ray_tmp, normal_tmp, size);
		if(t < t_min) {
			t_min = t;
			p = ray_at(ray, t);
			normal = vec3(transpose(r) * vec4(normal_tmp, 0.0));
			albedo = vec4(0.7, 0.7, 0.7, 0);
			emission = vec3(0);
			if(shade)
				shade_screen(iChannel1, iChannelResolution[1], ray_at(ray_tmp, t),
						normal_tmp, size, albedo, emission);
		}
	}

	/* small cube -> iChannel2 */
	if(cube_visible > 0.5) {
		vec3 normal_tmp;
		vec3 size = vec3(0.25, 0.25, 0.25);
		Ray ray_tmp = ray;
		ray_tmp.origin -= vec3(0.5, -0.75 + min(cube_react * 0.3, 0.9), 0.35);
		float t = intersect_box(ray_tmp, normal_tmp, size);
		if(t < t_min) {
			t_min = t;
			p = ray_at(ray, t);
			normal = normal_tmp;
			albedo = vec4(0.7, 0.7, 0.7, 0);
			emission = vec3(0);
			if(shade)
				shade_screen(iChannel2, iChannelResolution[2], ray_at(ray_tmp, t),
						normal_tmp, size, albedo, emission);
		}
	}

	if(walls_visible > 0.5) {
		float hue = walls_react * 2.0;
		vec3 red = clamp(hue_rotate(vec3(0.9, 0.1, 0.1), hue), 0.0, 0.95);
		vec3 green = clamp(hue_rotate(vec3(0.1, 0.9, 0.1), hue), 0.0, 0.95);

		// left
		{
			vec3 n = vec3(1, 0, 0);
			float t = intersect_plane(ray, vec3(-1, 0, 0), n);
			if(t < t_min) {
				vec3 p_tmp = ray_at(ray, t);
				if(all(lessThanEqual(p_tmp.yz, vec2(1))) && all(greaterThanEqual(p_tmp.yz,
								vec2(-1))))
				{
					normal = n;
					p = p_tmp;
					t_min = t;
					albedo = vec4(red, 0);
					emission = vec3(0);
				}
			}
		}
		// right
		{
			vec3 n = vec3(-1, 0, 0);
			float t = intersect_plane(ray, vec3(1, 0, 0), n);
			if(t < t_min) {
				vec3 p_tmp = ray_at(ray, t);
				if(all(lessThanEqual(p_tmp.yz, vec2(1))) && all(greaterThanEqual(p_tmp.yz,
								vec2(-1))))
				{
					normal = n;
					p = p_tmp;
					t_min = t;
					albedo = vec4(green, 0);
					emission = vec3(0);
				}
			}
		}
		// floor
		{
			vec3 n = vec3(0, 1, 0);
			float t = intersect_plane(ray, vec3(0, -1, 0), n);
			if(t < t_min) {
				vec3 p_tmp = ray_at(ray, t);
				if(all(lessThan(p_tmp.xz, vec2(1))) && all(greaterThan(p_tmp.xz,
								vec2(-1))))
				{
					normal = n;
					p = p_tmp;
					albedo = vec4(0.7, 0.7, 0.7, 0);
					emission = vec3(0);
					t_min = t;
				}
			}
		}
		// ceiling
		{
			vec3 n = vec3(0, -1, 0);
			float t = intersect_plane(ray, vec3(0, 1, 0), n);
			if(t < t_min) {
				vec3 p_tmp = ray_at(ray, t);
				if(all(lessThan(p_tmp.xz, vec2(1))) && all(greaterThan(p_tmp.xz,
								vec2(-1))))
				{
					normal = n;
					p = p_tmp;
					albedo = vec4(0.7, 0.7, 0.7, 0);
					emission = vec3(0);
					t_min = t;
				}
			}
		}
		// back wall
		{
			vec3 n = vec3(0, 0, 1);
			float t = intersect_plane(ray, vec3(0, 0, -1), n);
			if(t < t_min) {
				vec3 p_tmp = ray_at(ray, t);
				if(all(lessThan(p_tmp.xy, vec2(1))) && all(greaterThan(p_tmp.xy,
								vec2(-1))))
				{
					normal = n;
					p = p_tmp;
					albedo = vec4(0.7, 0.7, 0.7, 0);
					emission = vec3(0);
					t_min = t;
				}
			}
		}
	}

	normal = normalize(normal);

	return t_min;
}

bool
test_visibility(vec3 p1, vec3 p2)
{
	const float eps = 1e-5;

	Ray r = Ray(p1, normalize(p2 - p1));
	r.origin += eps * r.dir;

	vec3 n, p, e;
	vec4 a; // ignored
	float t_shadow = intersect(r, false, p, n, a, e);

	return t_shadow > distance(p1, p2) - 2.0 * eps;
}

vec3
pt_mis(Ray ray)
{
	vec3 contrib = vec3(0);
	vec3 tp = vec3(1.0);

	vec3 position, normal, emission;
	vec4 albedo;
	float t = intersect(ray, true, position, normal, albedo, emission);

	if(t == INFINITY)
		return vec3(0.0);

	if(albedo.a > 0.0) { /* hit light source */
		return albedo.rgb * albedo.a;
	}

	contrib += emission; /* video screens glow */

	for(int i = 0; i < NUM_BOUNCES; i++) {
		mat3 onb = construct_ONB_frisvad(normal);

		if(light_on) { /* NEE */
			vec3 pos_ls = sample_light(get_random());
			vec3 l_nee = pos_ls - position;
			float rr_nee = dot(l_nee, l_nee);
			l_nee /= sqrt(rr_nee);
			float G = max(0.0, dot(normal, l_nee)) * max(0.0, -dot(l_nee, light_normal)) / rr_nee;

			if(G > 0.0) {
				float light_pdf = 1.0 / (light_area * G);
				float brdf_pdf = 1.0 / PI;

				float w = light_pdf / (light_pdf + brdf_pdf);

				vec3 brdf = albedo.rgb / PI;

				if(test_visibility(position, pos_ls)) {
					vec3 Le = light_albedo.rgb * light_albedo.a;
					contrib += tp * (Le * w * brdf) / light_pdf;
				}
			}
		}

		{ /* brdf */
			vec3 dir = normalize(onb * sample_cos_hemisphere(get_random()));

			vec3 brdf = albedo.rgb / PI;

			Ray ray_next = Ray(position, dir);
			ray_next.origin += ray_next.dir * 1e-5;

			vec3 position_next, normal_next, emission_next;
			vec4 albedo_next;
			float t = intersect(ray_next, true, position_next, normal_next, albedo_next,
					emission_next);

			if(t == INFINITY)
				break;

			float brdf_pdf = 1.0 / PI;

			if(albedo_next.a > 0.0) { /* hit light_source */
				float G = max(0.0, dot(ray_next.dir, normal)) * max(0.0, -dot(ray_next.dir, normal_next)) / (t * t);
				if(G <= 0.0) /* hit back side of light source */
					break;

				float light_pdf = 1.0 / (light_area * G);

				float w = brdf_pdf / (light_pdf + brdf_pdf);

				vec3 Le = light_albedo.rgb * light_albedo.a;
				contrib += tp * (Le * w * brdf) / brdf_pdf;

				break;
			}

			tp *= brdf / brdf_pdf;

			/* screens are only reachable by brdf sampling, so no MIS weight */
			contrib += tp * emission_next;

			position = position_next;
			normal = normal_next;
			albedo = albedo_next;
		}
	}

	return contrib;
}

void
mainImage(out vec4 fragColor, in vec2 fragCoord)
{
	light_on = light_visible > 0.5;
	light_size = 0.5;
	light_area = light_size * light_size;
	light_position = vec3(0.5 * sin(iTime), 0.90, 0.5 * cos(iTime));
	light_normal = vec3(0, -1, 0);
	seed = 0;
	light_albedo = vec4(1, 1, 1, 2.0 / (light_size * light_size) * (1.0 + light_react));
	flat_idx = int(dot(gl_FragCoord.xy, vec2(1, 4096)));

	vec2 p = fragCoord.xy / vec2(iResolution) - vec2(0.5);
	float a = float(iResolution.x) / float(iResolution.y);
	if(a < 1.0)
		p.y /= a;
	else
		p.x *= a;

	vec3 cam_center = vec3(0, 0, 3.125);

	vec3 s = vec3(0);
	for(int i = 0; i < NUM_SAMPLES; i++) {
		Ray ray;
		ray.origin = cam_center;
		vec2 r = get_random();
		vec3 ray_dir = normalize(vec3(p + r.x * dFdx(p) + r.y * dFdy(p), -1));
		ray.dir = ray_dir;
		vec3 c = pt_mis(ray);
		s += c;
	}

	fragColor = vec4(pow(s / float(NUM_SAMPLES), vec3(1.0 / 2.2)), 1.0);
}
void main(){ vec4 c; mainImage(c, vUv*iResolution.xy); outColor = c; }
`;

/* The path tracer already tone-maps; the image pass just presents Buffer A. */
const imageShader = `
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D iChannel0;
void main(){ outColor = vec4(texture(iChannel0, vUv).rgb, 1.0); }
`;

export const cornell: ShaderDef = {
  id: 'cornell',
  name: 'Cornell Screens',
  description:
    'Path-traced Cornell box with an orbiting area light. Both boxes are video screens — load a clip for each below.',
  bufferShader,
  imageShader,
  glsl3: true,
  // 32 spp x 3 bounces is heavy; trace at CSS-pixel resolution like Shadertoy.
  maxPixelRatio: 1,
  videoChannels: [
    { channel: 1, name: 'Tall Box Screen', description: 'Plays on every face of the tall box.' },
    { channel: 2, name: 'Cube Screen', description: 'Plays on every face of the small cube.' },
  ],
  elements: [
    {
      id: 'light',
      name: 'Area Light',
      description: 'Orbiting ceiling light. React drives intensity. Hide it to light the room by the screens alone.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'screens',
      name: 'Video Screens',
      description: 'Video on the box surfaces. React drives screen glow. Hide for plain grey boxes.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tower',
      name: 'Tall Box',
      description: 'Tall box (iChannel1 screen). React drives spin.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'cube',
      name: 'Small Cube',
      description: 'Small cube (iChannel2 screen). React drives hop height.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'walls',
      name: 'Room Walls',
      description: 'Floor, ceiling and walls. React shifts the hue of the coloured walls.',
      defaultBand: 'high',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
