/**
 * UnityEngine型定義スタブ
 *
 * TypeScriptコンパイル用の最小スタブ。
 * UdonSharp実行時はUnityEngine側の型が使用される。
 */

import { UdonStub } from "./UdonDecorators.js";
import type { UdonFloat, UdonInt } from "./UdonTypes.js";

@UdonStub("UnityEngine.Object")
export class UnityObject {}

@UdonStub("UnityEngine.Component")
export class Component extends UnityObject {
  gameObject: GameObject = null as unknown as GameObject;
  transform: Transform = null as unknown as Transform;
}

@UdonStub("UnityEngine.GameObject")
export class GameObject extends UnityObject {
  name: string = "";
  activeSelf: boolean = true;
  transform: Transform = null as unknown as Transform;

  static Find(_name: string): GameObject {
    return null as unknown as GameObject;
  }

  SetActive(_value: boolean): void {}

  GetComponent<_T>(): _T {
    return null as unknown as _T;
  }

  AddComponent<_T>(): _T {
    return null as unknown as _T;
  }
}

@UdonStub("UnityEngine.Transform")
export class Transform extends Component {
  position: Vector3 = new Vector3(0, 0, 0);
  rotation: Quaternion = new Quaternion(0, 0, 0, 1);
  localPosition: Vector3 = new Vector3(0, 0, 0);
  localEulerAngles: Vector3 = new Vector3(0, 0, 0);
  localRotation: Quaternion = new Quaternion(0, 0, 0, 1);
  localScale: Vector3 = new Vector3(1, 1, 1);
  parent: Transform = null as unknown as Transform;
  childCount: UdonInt = 0 as UdonInt;

  SetParent(_parent: Transform): void {}

  GetChild(_index: UdonInt): Transform {
    return null as unknown as Transform;
  }
}

@UdonStub("UnityEngine.Vector3")
export class Vector3 {
  x: UdonFloat;
  y: UdonFloat;
  z: UdonFloat;
  magnitude: UdonFloat = 0 as UdonFloat;
  normalized: Vector3 = new Vector3(0, 0, 0);

  constructor(
    x: UdonFloat | number,
    y: UdonFloat | number,
    z: UdonFloat | number,
  ) {
    this.x = x as UdonFloat;
    this.y = y as UdonFloat;
    this.z = z as UdonFloat;
  }

  static zero: Vector3 = new Vector3(0, 0, 0);
  static one: Vector3 = new Vector3(1, 1, 1);
  static up: Vector3 = new Vector3(0, 1, 0);
  static forward: Vector3 = new Vector3(0, 0, 1);

  static Distance(_a: Vector3, _b: Vector3): UdonFloat {
    return 0 as UdonFloat;
  }

  static Lerp(_a: Vector3, _b: Vector3, _t: UdonFloat | number): Vector3 {
    return new Vector3(0, 0, 0);
  }

  static Cross(_a: Vector3, _b: Vector3): Vector3 {
    return new Vector3(0, 0, 0);
  }

  static Dot(_a: Vector3, _b: Vector3): UdonFloat {
    return 0 as UdonFloat;
  }

  static Angle(_a: Vector3, _b: Vector3): UdonFloat {
    return 0 as UdonFloat;
  }
}

@UdonStub("UnityEngine.Material")
export class Material extends UnityObject {
  SetTextureOffset(_name: string, _value: Vector3): void {}
  SetTextureScale(_name: string, _value: Vector3): void {}
  SetColor(_name: string, _value: Color): void {}
  SetFloat(_name: string, _value: UdonFloat | number): void {}
  GetColor(_name: string): Color {
    return new Color(0, 0, 0, 1);
  }

  color: Color = new Color(0, 0, 0, 1);
}

@UdonStub("UnityEngine.Renderer")
export class Renderer extends Component {
  material: Material = null as unknown as Material;
  materials: Material[] = [];
}

@UdonStub("TMPro.TextMeshProUGUI")
export class TextMeshProUGUI extends Component {
  text: string = "";
}

@UdonStub("TMPro.TextMeshPro")
export class TextMeshPro extends Component {
  text: string = "";
}

@UdonStub("UnityEngine.Time")
export class Time {
  static deltaTime: UdonFloat;
  static time: UdonFloat;
}

@UdonStub("UnityEngine.Mathf")
export class Mathf {
  static Abs(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Ceil(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static CeilToInt(_value: UdonFloat): UdonInt {
    return 0 as UdonInt;
  }
  static Clamp(_value: UdonFloat, _min: UdonFloat, _max: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Clamp01(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Floor(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static FloorToInt(_value: UdonFloat): UdonInt {
    return 0 as UdonInt;
  }
  static Lerp(_a: UdonFloat, _b: UdonFloat, _t: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Max(_a: UdonFloat, _b: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Min(_a: UdonFloat, _b: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Pow(_a: UdonFloat, _b: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Round(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static RoundToInt(_value: UdonFloat): UdonInt {
    return 0 as UdonInt;
  }
  static Sin(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Cos(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Sqrt(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
  static Tan(_value: UdonFloat): UdonFloat {
    return 0 as UdonFloat;
  }
}

@UdonStub("UnityEngine.Color")
export class Color {
  r: UdonFloat;
  g: UdonFloat;
  b: UdonFloat;
  a: UdonFloat;

  constructor(
    r: UdonFloat | number,
    g: UdonFloat | number,
    b: UdonFloat | number,
    a: UdonFloat | number,
  ) {
    this.r = r as UdonFloat;
    this.g = g as UdonFloat;
    this.b = b as UdonFloat;
    this.a = a as UdonFloat;
  }
}

@UdonStub("UnityEngine.Quaternion")
export class Quaternion {
  x: UdonFloat;
  y: UdonFloat;
  z: UdonFloat;
  w: UdonFloat;

  constructor(
    x: UdonFloat | number,
    y: UdonFloat | number,
    z: UdonFloat | number,
    w: UdonFloat | number,
  ) {
    this.x = x as UdonFloat;
    this.y = y as UdonFloat;
    this.z = z as UdonFloat;
    this.w = w as UdonFloat;
  }

  static identity: Quaternion = new Quaternion(0, 0, 0, 1);

  static Euler(
    _x: UdonFloat | number,
    _y: UdonFloat | number,
    _z: UdonFloat | number,
  ): Quaternion {
    return new Quaternion(0, 0, 0, 1);
  }

  static Lerp(
    _a: Quaternion,
    _b: Quaternion,
    _t: UdonFloat | number,
  ): Quaternion {
    return new Quaternion(0, 0, 0, 1);
  }
}

@UdonStub("UnityEngine.Debug")
export class Debug {
  static Log(_message: object): void;
  static Log(_message: string): void;
  static Log(_message: number): void;
  static Log(_message: boolean): void;
  static Log(_message: unknown): void {}

  static LogWarning(_message: object): void;
  static LogWarning(_message: string): void;
  static LogWarning(_message: number): void;
  static LogWarning(_message: boolean): void;
  static LogWarning(_message: unknown): void {}

  static LogError(_message: object): void;
  static LogError(_message: string): void;
  static LogError(_message: number): void;
  static LogError(_message: boolean): void;
  static LogError(_message: unknown): void {}
}

@UdonStub("UnityEngine.BoxCollider")
export class BoxCollider extends Component {
  size: Vector3 = new Vector3(1, 1, 1);
  center: Vector3 = new Vector3(0, 0, 0);
}

@UdonStub("UnityEngine.Rigidbody")
export class Rigidbody extends Component {
  AddForce(_force: Vector3): void {}
}

@UdonStub("UnityEngine.MeshRenderer")
export class MeshRenderer extends Renderer {}

@UdonStub("UnityEngine.MeshFilter")
export class MeshFilter extends Component {}

@UdonStub("UnityEngine.Canvas")
export class Canvas extends Component {}

@UdonStub("UnityEngine.CanvasGroup")
export class CanvasGroup extends Component {
  alpha: UdonFloat = 1 as UdonFloat;
  interactable: boolean = true;
  blocksRaycasts: boolean = true;
}

@UdonStub("UnityEngine.UI.Button")
export class Button extends Component {
  interactable: boolean = true;
}

@UdonStub("UnityEngine.UI.Toggle")
export class Toggle extends Component {
  isOn: boolean = false;
}

@UdonStub("UnityEngine.UI.Image")
export class Image extends Component {
  color: Color = new Color(
    1 as UdonFloat,
    1 as UdonFloat,
    1 as UdonFloat,
    1 as UdonFloat,
  );
}

@UdonStub("UnityEngine.UI.RawImage")
export class RawImage extends Component {}

@UdonStub("UnityEngine.RectTransform")
export class RectTransform extends Transform {
  anchoredPosition: Vector3 = new Vector3(0, 0, 0);
  sizeDelta: Vector3 = new Vector3(0, 0, 0);
}

@UdonStub("UnityEngine.Vector2")
export class Vector2 {
  x: UdonFloat;
  y: UdonFloat;

  constructor(x: UdonFloat | number, y: UdonFloat | number) {
    this.x = x as UdonFloat;
    this.y = y as UdonFloat;
  }
}

@UdonStub("UnityEngine.Bounds")
export class Bounds {
  center: Vector3 = new Vector3(0, 0, 0);
  size: Vector3 = new Vector3(0, 0, 0);
}

@UdonStub("UnityEngine.AudioSource")
export class AudioSource extends Component {
  volume: UdonFloat = 1 as UdonFloat;
  isPlaying: boolean = false;
  Play(): void {}
  Stop(): void {}
  PlayOneShot(_clip: AudioClip): void {}
}

@UdonStub("UnityEngine.AudioClip")
export class AudioClip extends UnityObject {}

@UdonStub("UnityEngine.Animator")
export class Animator extends Component {
  SetFloat(_name: string, _value: UdonFloat): void {}
  SetBool(_name: string, _value: boolean): void {}
  SetInteger(_name: string, _value: UdonInt): void {}
  SetTrigger(_name: string): void {}
  GetBool(_name: string): boolean {
    return false;
  }
  GetFloat(_name: string): UdonFloat {
    return 0 as UdonFloat;
  }
  GetInteger(_name: string): UdonInt {
    return 0 as UdonInt;
  }
}
