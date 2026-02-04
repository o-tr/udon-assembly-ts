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
  localPosition: Vector3 = new Vector3(0, 0, 0);
  localEulerAngles: Vector3 = new Vector3(0, 0, 0);
  localScale: Vector3 = new Vector3(1, 1, 1);

  SetParent(_parent: Transform): void {}
}

@UdonStub("UnityEngine.Vector3")
export class Vector3 {
  x: UdonFloat;
  y: UdonFloat;
  z: UdonFloat;

  constructor(
    x: UdonFloat | number,
    y: UdonFloat | number,
    z: UdonFloat | number,
  ) {
    this.x = x as UdonFloat;
    this.y = y as UdonFloat;
    this.z = z as UdonFloat;
  }
}

@UdonStub("UnityEngine.Material")
export class Material extends UnityObject {
  SetTextureOffset(_name: string, _value: Vector3): void {}
  SetTextureScale(_name: string, _value: Vector3): void {}
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
  static Clamp(_value: UdonFloat, _min: UdonFloat, _max: UdonFloat): UdonFloat {
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
}

@UdonStub("UnityEngine.Debug")
export class Debug {
  static Log(_message: string): void {}
  static LogWarning(_message: string): void {}
  static LogError(_message: string): void {}
}

@UdonStub("UnityEngine.BoxCollider")
export class BoxCollider extends Component {
  size: Vector3 = new Vector3(1, 1, 1);
  center: Vector3 = new Vector3(0, 0, 0);
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
  Play(): void {}
}

@UdonStub("UnityEngine.Animator")
export class Animator extends Component {
  SetFloat(_name: string, _value: UdonFloat): void {}
  SetBool(_name: string, _value: boolean): void {}
  SetInteger(_name: string, _value: UdonInt): void {}
  SetTrigger(_name: string): void {}
}
